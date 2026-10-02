//! PostgreSQL qua `tokio-postgres` (TLS rustls + ring).
//!
//! Một kết nối PostgreSQL chỉ gắn với MỘT database, nên phiên giữ một client cho
//! mỗi database đã dùng (mở khi cần, qua cùng tunnel). Câu lệnh của người dùng chạy
//! bằng simple-query: nhiều câu một lần, mọi giá trị về dạng text — hợp cho lưới
//! kết quả hiển thị kiểu bất kỳ.

use super::{tls, Column, ConnectSpec, ResultSet, TreeNode};
use futures_util::{pin_mut, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tokio_postgres::config::SslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::{CancelToken, Client, Config, SimpleQueryMessage};
use tokio_postgres_rustls::MakeRustlsConnect;

struct PgConn {
    client: Client,
    /// Task chạy `Connection` của driver; huỷ khi client bị bỏ.
    driver: AbortHandle,
}

impl Drop for PgConn {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

pub struct PgSession {
    base: Config,
    tls: MakeRustlsConnect,
    default_db: String,
    read_only: bool,
    clients: Mutex<HashMap<String, Arc<PgConn>>>,
    /// Cancel token của câu lệnh đang chạy (nếu có).
    running: std::sync::Mutex<Option<CancelToken>>,
}

impl PgSession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        let mut base = Config::new();
        base.user(&spec.username)
            .password(&spec.password)
            .port(spec.port)
            .application_name("Termez")
            .connect_timeout(Duration::from_secs(20))
            .ssl_mode(match spec.ssl_mode.as_str() {
                "disable" => SslMode::Disable,
                "require" | "verify" => SslMode::Require,
                _ => SslMode::Prefer,
            });
        if spec.tls_host != spec.host {
            // Qua tunnel: nối tới 127.0.0.1 nhưng TLS/SNI dùng tên host thật.
            base.host(&spec.tls_host).hostaddr(spec.host.parse()?);
        } else {
            base.host(&spec.host);
        }
        let tls = MakeRustlsConnect::new(tls::client_config(spec.ssl_mode == "verify")?);
        let default_db = spec
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "postgres".into());
        let session = Self {
            base,
            tls,
            default_db: default_db.clone(),
            read_only: spec.read_only,
            clients: Mutex::new(HashMap::new()),
            running: std::sync::Mutex::new(None),
        };
        let c = session.client(&default_db).await?;
        let version = c
            .client
            .query_one("SHOW server_version", &[])
            .await
            .map(|r| r.get::<_, String>(0))
            .unwrap_or_default();
        Ok((session, version))
    }

    pub fn default_database(&self) -> &str {
        &self.default_db
    }

    async fn client(&self, db: &str) -> anyhow::Result<Arc<PgConn>> {
        let mut map = self.clients.lock().await;
        if let Some(c) = map.get(db) {
            if !c.client.is_closed() {
                return Ok(c.clone());
            }
        }
        let mut cfg = self.base.clone();
        cfg.dbname(db);
        let (client, connection) = cfg.connect(self.tls.clone()).await.map_err(pg_error)?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        })
        .abort_handle();
        let conn = Arc::new(PgConn { client, driver });
        if self.read_only {
            conn.client.batch_execute("SET default_transaction_read_only = on").await?;
        }
        map.insert(db.to_string(), conn.clone());
        Ok(conn)
    }

    pub async fn query(
        &self,
        database: Option<String>,
        sql: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        let db = database.unwrap_or_else(|| self.default_db.clone());
        let c = self.client(&db).await?;
        *self.running.lock().unwrap() = Some(c.client.cancel_token());
        let res = self.run(&c.client, sql, limit).await;
        *self.running.lock().unwrap() = None;
        Ok((res?, Some(db)))
    }

    async fn run(&self, client: &Client, sql: &str, limit: usize) -> anyhow::Result<Vec<ResultSet>> {
        let stream = client.simple_query_raw(sql).await?;
        pin_mut!(stream);
        let mut sets: Vec<ResultSet> = Vec::new();
        let mut cur: Option<ResultSet> = None;
        // Vượt giới hạn dòng → huỷ phía server cho khỏi truyền phần còn lại.
        let mut cut = false;
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(e) if cut && e.code() == Some(&SqlState::QUERY_CANCELED) => break,
                Err(e) => return Err(pg_error(e)),
            };
            match msg {
                SimpleQueryMessage::RowDescription(cols) => {
                    cur = Some(ResultSet {
                        columns: cols
                            .iter()
                            .map(|c| Column { name: c.name().to_string(), type_name: None })
                            .collect(),
                        ..Default::default()
                    });
                }
                SimpleQueryMessage::Row(row) => {
                    let set = cur.get_or_insert_with(ResultSet::default);
                    if set.rows.len() < limit {
                        set.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                    } else if !set.truncated {
                        set.truncated = true;
                        cut = true;
                        let token = client.cancel_token();
                        let tls = self.tls.clone();
                        tokio::spawn(async move {
                            let _ = token.cancel_query(tls).await;
                        });
                    }
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    let mut set = cur.take().unwrap_or_default();
                    if set.columns.is_empty() {
                        set.affected = Some(n);
                    }
                    sets.push(set);
                }
                _ => {}
            }
        }
        if let Some(set) = cur.take() {
            sets.push(set);
        }
        Ok(sets)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let token = self.running.lock().unwrap().clone();
        if let Some(token) = token {
            token.cancel_query(self.tls.clone()).await?;
        }
        Ok(())
    }

    /// Cây: [] → databases; [db] → schemas; [db, schema] → bảng/view; [db, schema, bảng] → cột.
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        let node = |name: String, kind: &str, detail: Option<String>, leaf: bool| TreeNode {
            name,
            kind: kind.into(),
            detail,
            leaf,
        };
        Ok(match path {
            [] => {
                let c = self.client(&self.default_db).await?;
                c.client
                    .query(
                        "SELECT datname FROM pg_database \
                         WHERE NOT datistemplate AND datallowconn ORDER BY datname",
                        &[],
                    )
                    .await?
                    .iter()
                    .map(|r| node(r.get(0), "database", None, false))
                    .collect()
            }
            [db] => {
                let c = self.client(db).await?;
                c.client
                    .query(
                        "SELECT nspname FROM pg_namespace \
                         WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' \
                         ORDER BY nspname",
                        &[],
                    )
                    .await?
                    .iter()
                    .map(|r| node(r.get(0), "schema", None, false))
                    .collect()
            }
            [db, schema] => {
                let c = self.client(db).await?;
                c.client
                    .query(
                        "SELECT c.relname, c.relkind::text FROM pg_class c \
                         JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') \
                         ORDER BY c.relname",
                        &[schema],
                    )
                    .await?
                    .iter()
                    .map(|r| {
                        let kind: String = r.get(1);
                        let (kind, detail) = match kind.as_str() {
                            "v" => ("view", None),
                            "m" => ("view", Some("materialized".to_string())),
                            "f" => ("table", Some("foreign".to_string())),
                            "p" => ("table", Some("partitioned".to_string())),
                            _ => ("table", None),
                        };
                        node(r.get(0), kind, detail, false)
                    })
                    .collect()
            }
            [db, schema, table] => {
                let c = self.client(db).await?;
                c.client
                    .query(
                        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                           EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid \
                                   AND i.indisprimary AND a.attnum = ANY(i.indkey)) \
                         FROM pg_attribute a \
                         JOIN pg_class c ON c.oid = a.attrelid \
                         JOIN pg_namespace n ON n.oid = c.relnamespace \
                         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 \
                           AND NOT a.attisdropped \
                         ORDER BY a.attnum",
                        &[schema, table],
                    )
                    .await?
                    .iter()
                    .map(|r| {
                        let ty: String = r.get(1);
                        let pk: bool = r.get(2);
                        node(r.get(0), "column", Some(if pk { format!("{ty} · PK") } else { ty }), true)
                    })
                    .collect()
            }
            _ => Vec::new(),
        })
    }
}

/// Lỗi server → thông điệp gọn kèm vị trí/gợi ý (mặc định chỉ "db error").
fn pg_error(e: tokio_postgres::Error) -> anyhow::Error {
    match e.as_db_error() {
        Some(db) => {
            let mut msg = format!("{}: {}", db.severity(), db.message());
            if let Some(d) = db.detail() {
                msg.push_str(&format!("\nDETAIL: {d}"));
            }
            if let Some(h) = db.hint() {
                msg.push_str(&format!("\nHINT: {h}"));
            }
            anyhow::anyhow!(msg)
        }
        None => e.into(),
    }
}
