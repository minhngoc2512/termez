//! PostgreSQL qua `tokio-postgres` (TLS rustls + ring).
//!
//! Một kết nối PostgreSQL chỉ gắn với MỘT database, nên phiên giữ một client cho
//! mỗi database đã dùng (mở khi cần, qua cùng tunnel). Câu lệnh của người dùng chạy
//! bằng simple-query: nhiều câu một lần, mọi giá trị về dạng text — hợp cho lưới
//! kết quả hiển thị kiểu bất kỳ.

use super::{num, tls, Column, ConnectSpec, MonitorRow, MonitorSnapshot, MonitorTable, ResultSet, TableSizes, TableStat, TreeNode};
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

    /// Monitor: pg_stat_database (bộ đếm), pg_stat_activity (phiên), pg_locks, uptime.
    pub async fn monitor(&self, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        let c = self.client(&self.default_db).await?;
        let mut snap = MonitorSnapshot::default();
        let stats = text_rows(
            &c.client,
            "SELECT sum(xact_commit), sum(xact_rollback), sum(blks_read), sum(blks_hit), \
               sum(tup_returned) + sum(tup_fetched), sum(tup_inserted) + sum(tup_updated) + sum(tup_deleted), \
               sum(deadlocks), sum(temp_bytes) FROM pg_stat_database; \
             SELECT count(*) FILTER (WHERE state = 'active'), count(*) FILTER (WHERE state = 'idle'), \
               count(*) FILTER (WHERE state LIKE 'idle in transaction%'), count(*) \
             FROM pg_stat_activity WHERE backend_type = 'client backend'; \
             SELECT count(*) FROM pg_locks WHERE NOT granted; \
             SELECT current_setting('max_connections'), extract(epoch FROM now() - pg_postmaster_start_time())",
        )
        .await?;
        let names = [
            "xact_commit", "xact_rollback", "blks_read", "blks_hit", "rows_read", "rows_written", "deadlocks",
            "temp_bytes", "sessions_active", "sessions_idle", "sessions_idle_tx", "sessions_total", "locks_waiting",
            "max_connections", "uptime",
        ];
        for (name, v) in names.iter().zip(stats.iter().flatten()) {
            if let Some(n) = v.as_deref().and_then(num) {
                snap.values.insert(name.to_string(), n);
            }
        }
        let rows = text_rows(
            &c.client,
            "SELECT pid, usename, datname, client_addr::text, state, wait_event_type, \
               extract(epoch FROM now() - query_start)::int, left(query, 500) \
             FROM pg_stat_activity \
             WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() AND state <> 'idle' \
             ORDER BY query_start NULLS LAST LIMIT 200",
        )
        .await?;
        snap.tables.push(MonitorTable {
            title: "Running queries".into(),
            columns: ["pid", "user", "database", "client", "state", "waiting on", "time (s)", "query"].map(String::from).to_vec(),
            rows: rows
                .into_iter()
                .map(|cells| MonitorRow { id: cells.first().cloned().flatten(), cells })
                .collect(),
            killable: true,
        });
        if breakdown {
            let sizes = text_rows(
                &c.client,
                "SELECT datname, pg_database_size(datname) FROM pg_database \
                 WHERE datallowconn AND NOT datistemplate ORDER BY 2 DESC LIMIT 20",
            )
            .await?;
            snap.breakdown = Some(
                sizes
                    .into_iter()
                    .filter_map(|r| Some((r.first()?.clone()?, r.get(1)?.as_deref().and_then(num).unwrap_or(0.0))))
                    .collect(),
            );
        }
        Ok(snap)
    }

    /// Bảng của một database (mọi schema người dùng): số dòng ước lượng (reltuples),
    /// tổng dung lượng / phần bảng / phần index.
    pub async fn table_sizes(&self, database: &str) -> anyhow::Result<TableSizes> {
        let c = self.client(database).await?;
        let rows = text_rows(
            &c.client,
            "SELECT n.nspname || '.' || c.relname, \
               CASE c.relkind WHEN 'p' THEN 'partitioned' WHEN 'm' THEN 'materialized view' ELSE 'table' END, \
               CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, \
               pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid) \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
               AND n.nspname NOT LIKE 'pg\\_toast%' \
             ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 2000",
        )
        .await?;
        let n = |r: &Vec<Option<String>>, i: usize| r.get(i).cloned().flatten().as_deref().and_then(num);
        Ok(TableSizes {
            tables: rows
                .iter()
                .map(|r| TableStat {
                    name: r.first().cloned().flatten().unwrap_or_default(),
                    engine: r.get(1).cloned().flatten(),
                    rows: n(r, 2),
                    total_bytes: n(r, 3).unwrap_or(0.0),
                    data_bytes: n(r, 4),
                    index_bytes: n(r, 5),
                    uncompressed_bytes: None,
                })
                .collect(),
            rows_exact: false,
        })
    }

    /// pg_cancel_backend(pid): huỷ câu lệnh đang chạy (không cắt phiên).
    pub async fn kill(&self, target: &str) -> anyhow::Result<()> {
        let pid: i32 = target.parse().map_err(|_| anyhow::anyhow!("pid không hợp lệ"))?;
        let c = self.client(&self.default_db).await?;
        c.client.query_one("SELECT pg_cancel_backend($1)", &[&pid]).await.map_err(pg_error)?;
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

/// Chạy (nhiều) câu bằng simple-query, trả mọi dòng dạng text (gộp các tập kết quả).
async fn text_rows(client: &Client, sql: &str) -> anyhow::Result<Vec<Vec<Option<String>>>> {
    Ok(client
        .simple_query(sql)
        .await
        .map_err(pg_error)?
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => Some((0..r.len()).map(|i| r.get(i).map(str::to_string)).collect()),
            _ => None,
        })
        .collect())
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
