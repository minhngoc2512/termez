//! MySQL / MariaDB qua `mysql_async` (TLS rustls + ring).
//!
//! Hai kết nối mỗi phiên: `editor` chạy câu lệnh của người dùng (giữ trạng thái
//! `USE db`, biến phiên…), `meta` cho cây schema và `KILL QUERY` — để duyệt bảng
//! hay huỷ không phải chờ một query dài đang chạy.

use super::{num, quote_mysql, Column, ConnectSpec, MonitorRow, MonitorSnapshot, MonitorTable, ResultSet, TreeNode};
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, OptsBuilder, Row, SslOpts, Value};
use tokio::sync::Mutex;

pub struct MySession {
    opts: Opts,
    /// Kết nối cho editor + database đang chọn trên kết nối đó.
    editor: Mutex<(Conn, Option<String>)>,
    editor_id: u32,
    meta: Mutex<Option<Conn>>,
}

fn ssl_opts(spec: &ConnectSpec, verify: bool) -> SslOpts {
    let opts = SslOpts::default();
    if verify {
        // Qua tunnel driver nối 127.0.0.1 → kiểm tra chứng chỉ theo tên host thật.
        if spec.tls_host != spec.host {
            return opts.with_danger_tls_hostname_override(Some(spec.tls_host.clone()));
        }
        opts
    } else {
        opts.with_danger_accept_invalid_certs(true).with_danger_skip_domain_validation(true)
    }
}

fn build_opts(spec: &ConnectSpec, ssl: Option<SslOpts>) -> Opts {
    let mut init: Vec<String> = Vec::new();
    if spec.read_only {
        init.push("SET SESSION TRANSACTION READ ONLY".into());
    }
    OptsBuilder::default()
        .ip_or_hostname(spec.host.clone())
        .tcp_port(spec.port)
        .user(Some(spec.username.clone()))
        .pass(Some(spec.password.clone()))
        .db_name(spec.database.clone().filter(|d| !d.is_empty()))
        .prefer_socket(false)
        .ssl_opts(ssl)
        .init(init)
        .into()
}

impl MySession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        let opts = match spec.ssl_mode.as_str() {
            "disable" => build_opts(spec, None),
            "require" => build_opts(spec, Some(ssl_opts(spec, false))),
            "verify" => build_opts(spec, Some(ssl_opts(spec, true))),
            // "prefer": thử TLS (không kiểm chứng chỉ), server không hỗ trợ → nối thường.
            _ => {
                let tls = build_opts(spec, Some(ssl_opts(spec, false)));
                match Conn::new(tls.clone()).await {
                    Ok(conn) => return Ok(Self::from_conn(tls, conn).await),
                    Err(mysql_async::Error::Driver(mysql_async::DriverError::NoClientSslFlagFromServer)) => {
                        build_opts(spec, None)
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        };
        let conn = Conn::new(opts.clone()).await?;
        Ok(Self::from_conn(opts, conn).await)
    }

    async fn from_conn(opts: Opts, conn: Conn) -> (Self, String) {
        let (a, b, c) = conn.server_version();
        let mut version = format!("{a}.{b}.{c}");
        let mut conn = conn;
        // MariaDB báo "5.5.5-10.x" ở bắt tay → hỏi VERSION() cho đúng.
        if let Ok(Some(v)) = conn.query_first::<String, _>("SELECT VERSION()").await {
            version = v;
        }
        let editor_id = conn.id();
        let db = conn.query_first::<Option<String>, _>("SELECT DATABASE()").await.ok().flatten().flatten();
        (
            Self { opts, editor: Mutex::new((conn, db)), editor_id, meta: Mutex::new(None) },
            version,
        )
    }

    pub async fn current_database(&self) -> Option<String> {
        self.editor.lock().await.1.clone()
    }

    /// Kết nối phụ (tạo khi cần, tạo lại nếu đã rớt).
    async fn meta(&self) -> anyhow::Result<tokio::sync::MutexGuard<'_, Option<Conn>>> {
        let mut g = self.meta.lock().await;
        let alive = match g.as_mut() {
            Some(c) => c.ping().await.is_ok(),
            None => false,
        };
        if !alive {
            *g = Some(Conn::new(self.opts.clone()).await?);
        }
        Ok(g)
    }

    pub async fn query(
        &self,
        database: Option<String>,
        sql: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        let mut g = self.editor.lock().await;
        let (conn, current) = &mut *g;
        if let Some(db) = database {
            if current.as_deref() != Some(db.as_str()) {
                conn.query_drop(format!("USE {}", quote_mysql(&db))).await?;
                *current = Some(db);
            }
        }

        let mut sets = Vec::new();
        {
            let mut qr = conn.query_iter(sql).await?;
            loop {
                let columns: Vec<Column> = qr
                    .columns()
                    .map(|cols| {
                        cols.iter()
                            .map(|c| Column {
                                name: c.name_str().into_owned(),
                                type_name: Some(type_name(c.column_type())),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // Đọc trước khi next(): next() có thể nhảy sang tập kết quả sau.
                let affected = qr.affected_rows();
                let mut set = ResultSet { columns, ..Default::default() };
                while let Some(row) = qr.next().await? {
                    if set.rows.len() < limit {
                        set.rows.push(row_strings(row));
                    } else {
                        set.truncated = true;
                    }
                }
                if set.columns.is_empty() {
                    set.affected = Some(affected);
                }
                sets.push(set);
                if qr.is_empty() {
                    break;
                }
            }
        }
        // Người dùng có thể vừa `USE` sang database khác.
        if let Ok(Some(db)) = conn.query_first::<Option<String>, _>("SELECT DATABASE()").await {
            *current = db;
        }
        Ok((sets, current.clone()))
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let mut g = self.meta().await?;
        if let Some(c) = g.as_mut() {
            c.query_drop(format!("KILL QUERY {}", self.editor_id)).await?;
        }
        Ok(())
    }

    /// Monitor: SHOW GLOBAL STATUS (bộ đếm + giá trị tức thời) và PROCESSLIST.
    pub async fn monitor(&self, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        const KEYS: [&str; 16] = [
            "Questions", "Com_select", "Com_insert", "Com_update", "Com_delete", "Threads_connected",
            "Threads_running", "Slow_queries", "Bytes_received", "Bytes_sent",
            "Innodb_buffer_pool_read_requests", "Innodb_buffer_pool_reads", "Uptime",
            "Aborted_connects", "Connections", "Innodb_row_lock_waits",
        ];
        let mut g = self.meta().await?;
        let conn = g.as_mut().expect("meta conn");
        let mut snap = MonitorSnapshot::default();
        for (k, v) in conn.query::<(String, String), _>("SHOW GLOBAL STATUS").await? {
            if KEYS.contains(&k.as_str()) {
                if let Some(n) = num(&v) {
                    snap.values.insert(k, n);
                }
            }
        }
        if let Some((_, v)) = conn.query_first::<(String, String), _>("SHOW VARIABLES LIKE 'max_connections'").await? {
            if let Some(n) = num(&v) {
                snap.values.insert("max_connections".into(), n);
            }
        }
        let rows: Vec<Row> = conn
            .query(
                "SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 500) \
                 FROM information_schema.PROCESSLIST \
                 WHERE COMMAND NOT IN ('Sleep', 'Daemon', 'Binlog Dump') AND ID <> CONNECTION_ID() \
                 ORDER BY TIME DESC LIMIT 200",
            )
            .await?;
        snap.tables.push(MonitorTable {
            title: "Running queries".into(),
            columns: ["id", "user", "host", "db", "command", "time (s)", "state", "query"].map(String::from).to_vec(),
            rows: rows
                .into_iter()
                .map(|r| {
                    let cells = row_strings(r);
                    MonitorRow { id: cells.first().cloned().flatten(), cells }
                })
                .collect(),
            killable: true,
        });
        if breakdown {
            let sizes: Vec<(String, Option<String>)> = conn
                .query(
                    "SELECT TABLE_SCHEMA, CAST(SUM(DATA_LENGTH + INDEX_LENGTH) AS CHAR) FROM information_schema.TABLES \
                     WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','sys','mysql') \
                     GROUP BY TABLE_SCHEMA ORDER BY SUM(DATA_LENGTH + INDEX_LENGTH) DESC LIMIT 20",
                )
                .await?;
            snap.breakdown = Some(sizes.into_iter().map(|(db, b)| (db, b.as_deref().and_then(num).unwrap_or(0.0))).collect());
        }
        Ok(snap)
    }

    /// KILL QUERY <id> (id là số thread trong PROCESSLIST).
    pub async fn kill(&self, target: &str) -> anyhow::Result<()> {
        let id: u64 = target.parse().map_err(|_| anyhow::anyhow!("id không hợp lệ"))?;
        let mut g = self.meta().await?;
        g.as_mut().expect("meta conn").query_drop(format!("KILL QUERY {id}")).await?;
        Ok(())
    }

    /// Cây: [] → databases; [db] → bảng/view; [db, bảng] → cột.
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        let mut g = self.meta().await?;
        let conn = g.as_mut().expect("meta conn");
        Ok(match path {
            [] => conn
                .query::<String, _>("SHOW DATABASES")
                .await?
                .into_iter()
                .map(|name| TreeNode { name, kind: "database".into(), detail: None, leaf: false })
                .collect(),
            [db] => conn
                .exec::<(String, String), _, _>(
                    "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
                     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                    (db,),
                )
                .await?
                .into_iter()
                .map(|(name, ty)| TreeNode {
                    name,
                    kind: if ty.contains("VIEW") { "view" } else { "table" }.into(),
                    detail: None,
                    leaf: false,
                })
                .collect(),
            [db, table] => conn
                .exec::<(String, String, String), _, _>(
                    "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                    (db, table),
                )
                .await?
                .into_iter()
                .map(|(name, ty, key)| TreeNode {
                    name,
                    kind: "column".into(),
                    detail: Some(if key == "PRI" { format!("{ty} · PK") } else { ty }),
                    leaf: true,
                })
                .collect(),
            _ => Vec::new(),
        })
    }
}

/// "MYSQL_TYPE_VAR_STRING" → "var_string".
fn type_name(t: mysql_async::consts::ColumnType) -> String {
    let s = format!("{t:?}");
    s.trim_start_matches("MYSQL_TYPE_").to_ascii_lowercase()
}

fn row_strings(row: Row) -> Vec<Option<String>> {
    row.unwrap().into_iter().map(value_string).collect()
}

fn value_string(v: Value) -> Option<String> {
    match v {
        Value::NULL => None,
        // Text protocol trả mọi giá trị dạng byte; dữ liệu nhị phân → hex.
        Value::Bytes(b) => Some(match String::from_utf8(b) {
            Ok(s) => s,
            Err(e) => {
                let b = e.into_bytes();
                let mut s = String::with_capacity(2 + b.len() * 2);
                s.push_str("0x");
                for x in b {
                    s.push_str(&format!("{x:02X}"));
                }
                s
            }
        }),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}
