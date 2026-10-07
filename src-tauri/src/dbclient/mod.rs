//! Client database cho mục Databases (MySQL/MariaDB, PostgreSQL; các loại khác thêm sau).
//!
//! Mỗi lần mở một kết nối đã lưu = một PHIÊN giữ trong `DbManager` cho tới khi pane
//! đóng. Nếu kết nối đi qua SSH, phiên giữ luôn tunnel (cổng local ngẫu nhiên) và
//! driver kết nối vào 127.0.0.1:<cổng đó>; TLS vẫn kiểm tra theo tên host thật.

mod bigquery;
mod clickhouse;
mod gauth;
mod mongo;
mod mongo_shell;
mod mysql;
mod postgres;
mod redis;
mod tls;

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

/// Thời gian chờ tối đa khi kết nối (gồm cả bắt tay TLS / xác thực).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Thông số kết nối đã resolve (mật khẩu lấy từ keychain, tunnel đã mở nếu có).
#[derive(Clone)]
pub struct ConnectSpec {
    /// "mysql" | "mariadb" | "postgres" | "clickhouse" | "redis" | "mongodb" | "bigquery"
    pub kind: String,
    /// Địa chỉ driver kết nối thật (127.0.0.1 khi đi qua tunnel).
    pub host: String,
    pub port: u16,
    /// Tên host dùng để kiểm tra chứng chỉ TLS (= host đã cấu hình).
    pub tls_host: String,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    /// "disable" | "prefer" | "require" | "verify"
    pub ssl_mode: String,
    pub read_only: bool,
    /// JSON tuỳ chọn riêng từng loại (MongoDB: {"authSource": "...", "uri": "mongodb+srv://..."}).
    pub options: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct Column {
    pub name: String,
    /// Kiểu cột nếu driver cho biết (MySQL có; PostgreSQL simple-query thì không).
    pub type_name: Option<String>,
}

/// Một tập kết quả. Câu lệnh không trả dòng (UPDATE…) → `columns` rỗng, có `affected`.
#[derive(Serialize, Default)]
pub struct ResultSet {
    pub columns: Vec<Column>,
    /// Giá trị dạng chuỗi (NULL = None) — đủ để hiển thị/xuất CSV cho mọi kiểu.
    pub rows: Vec<Vec<Option<String>>>,
    pub affected: Option<u64>,
    /// true nếu có nhiều dòng hơn giới hạn (phần dư bị bỏ).
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct QueryOutput {
    pub results: Vec<ResultSet>,
    pub elapsed_ms: u64,
    /// Database đang dùng sau khi chạy (người dùng có thể đổi bằng `USE …`).
    pub database: Option<String>,
}

#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    /// "database" | "schema" | "table" | "view" | "collection" | "column" | "key" | "info"
    pub kind: String,
    /// Thông tin phụ (kiểu cột, khoá chính…).
    pub detail: Option<String>,
    pub leaf: bool,
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub kind: String,
    pub database: Option<String>,
    pub server_version: String,
    pub read_only: bool,
    /// Database chọn trong cấu hình kết nối (None = không chọn → hiện mọi database).
    /// Redis: "db<n>" cho khớp tên node trong cây.
    pub configured_database: Option<String>,
}

/// Một lần đo cho màn Monitor. `values` gồm cả bộ đếm luỹ kế (giao diện tự tính
/// tốc độ từ chênh lệch hai lần đo) lẫn giá trị tức thời — tên khoá theo từng loại DB.
#[derive(Serialize, Default)]
pub struct MonitorSnapshot {
    pub values: HashMap<String, f64>,
    /// Phân bổ (dung lượng mỗi database, số key mỗi db…) — chỉ khi được hỏi.
    pub breakdown: Option<Vec<(String, f64)>>,
    pub tables: Vec<MonitorTable>,
}

#[derive(Serialize)]
pub struct MonitorTable {
    pub title: String,
    pub columns: Vec<String>,
    pub rows: Vec<MonitorRow>,
    /// Dòng có `id` thì huỷ được (KILL QUERY / pg_cancel_backend / CLIENT KILL).
    pub killable: bool,
}

#[derive(Serialize)]
pub struct MonitorRow {
    pub id: Option<String>,
    pub cells: Vec<Option<String>>,
}

/// Kích thước / số dòng của một bảng (popup "Disk usage" của Monitor).
#[derive(Serialize)]
pub struct TableStat {
    pub name: String,
    pub engine: Option<String>,
    pub rows: Option<f64>,
    /// Dung lượng trên đĩa (data + index; ClickHouse: phần đã nén).
    pub total_bytes: f64,
    pub data_bytes: Option<f64>,
    pub index_bytes: Option<f64>,
    /// ClickHouse: dung lượng chưa nén (xem tỉ lệ nén).
    pub uncompressed_bytes: Option<f64>,
}

#[derive(Serialize)]
pub struct TableSizes {
    pub tables: Vec<TableStat>,
    /// false = số dòng là ước lượng của server (MySQL TABLE_ROWS, PostgreSQL reltuples).
    pub rows_exact: bool,
}

/// Chuỗi số → f64 (bỏ qua giá trị không phải số).
fn num(v: &str) -> Option<f64> {
    v.trim().parse::<f64>().ok()
}

enum Backend {
    Mysql(mysql::MySession),
    Postgres(postgres::PgSession),
    ClickHouse(clickhouse::ChSession),
    Redis(redis::RedisSession),
    Mongo(mongo::MongoSession),
    BigQuery(bigquery::BqSession),
}

struct Session {
    backend: Backend,
    tunnel: Option<AbortHandle>,
    read_only: bool,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(t) = &self.tunnel {
            t.abort();
        }
    }
}

async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Backend, String)> {
    let fut = async {
        match spec.kind.as_str() {
            "mysql" | "mariadb" => {
                let (s, v) = mysql::MySession::connect(spec).await?;
                Ok((Backend::Mysql(s), v))
            }
            "postgres" => {
                let (s, v) = postgres::PgSession::connect(spec).await?;
                Ok((Backend::Postgres(s), v))
            }
            "clickhouse" => {
                let (s, v) = clickhouse::ChSession::connect(spec).await?;
                Ok((Backend::ClickHouse(s), v))
            }
            "redis" => {
                let (s, v) = redis::RedisSession::connect(spec).await?;
                Ok((Backend::Redis(s), v))
            }
            "mongodb" => {
                let (s, v) = mongo::MongoSession::connect(spec).await?;
                Ok((Backend::Mongo(s), v))
            }
            "bigquery" => {
                let (s, v) = bigquery::BqSession::connect(spec).await?;
                Ok((Backend::BigQuery(s), v))
            }
            other => anyhow::bail!("Loại database chưa hỗ trợ: {other}"),
        }
    };
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| anyhow::anyhow!("Hết thời gian chờ kết nối ({}s)", CONNECT_TIMEOUT.as_secs()))?
}

/// Kết nối tạm để lấy danh sách database (cho ô chọn database trong form).
pub async fn list_databases(spec: &ConnectSpec) -> anyhow::Result<Vec<String>> {
    let (backend, _) = connect(spec).await?;
    let nodes = match &backend {
        Backend::Mysql(s) => s.tree(&[]).await?,
        Backend::Postgres(s) => s.tree(&[]).await?,
        Backend::ClickHouse(s) => s.tree(&[]).await?,
        Backend::Redis(s) => s.tree(&[]).await?,
        Backend::Mongo(s) => s.tree(&[]).await?,
        Backend::BigQuery(s) => s.tree(&[]).await?,
    };
    Ok(nodes
        .into_iter()
        .filter(|n| n.kind == "database")
        .map(|n| match &backend {
            // Redis: "db3" → "3" (ô database nhận số index).
            Backend::Redis(_) => n.name.trim_start_matches("db").to_string(),
            _ => n.name,
        })
        .collect())
}

/// Thử kết nối rồi đóng ngay (drop = ngắt kết nối) — trả về phiên bản server.
pub async fn test(spec: &ConnectSpec) -> anyhow::Result<String> {
    let (_backend, version) = connect(spec).await?;
    Ok(version)
}

#[derive(Default)]
pub struct DbManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl DbManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mở phiên. `tunnel` (nếu có) sống cùng phiên và bị huỷ khi phiên đóng.
    pub async fn open(&self, spec: ConnectSpec, tunnel: Option<AbortHandle>) -> anyhow::Result<SessionInfo> {
        let res = connect(&spec).await;
        let (backend, server_version) = match res {
            Ok(v) => v,
            Err(err) => {
                if let Some(t) = tunnel {
                    t.abort();
                }
                return Err(err);
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        let database = match &backend {
            Backend::Mysql(s) => s.current_database().await,
            Backend::Postgres(s) => Some(s.default_database().to_string()),
            Backend::ClickHouse(s) => s.default_database(),
            Backend::Redis(s) => Some(s.default_database()),
            Backend::Mongo(s) => s.default_database().or(s.current_database().await),
            Backend::BigQuery(s) => s.default_database(),
        };
        self.sessions
            .lock()
            .await
            .insert(id.clone(), Arc::new(Session { backend, tunnel, read_only: spec.read_only }));
        let configured_database = spec.database.clone().filter(|d| !d.trim().is_empty()).map(|d| {
            if spec.kind == "redis" {
                format!("db{}", d.trim().trim_start_matches("db"))
            } else {
                d
            }
        });
        Ok(SessionInfo {
            session_id: id,
            kind: spec.kind,
            database,
            server_version,
            read_only: spec.read_only,
            configured_database,
        })
    }

    async fn get(&self, id: &str) -> anyhow::Result<Arc<Session>> {
        self.sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Phiên database đã đóng"))
    }

    /// Đóng phiên: drop kết nối (driver tự ngắt) + huỷ tunnel. Nếu một query vẫn
    /// đang giữ phiên thì việc đóng hoàn tất khi query đó trả về.
    pub async fn close(&self, id: &str) {
        self.sessions.lock().await.remove(id);
    }

    pub async fn tree(&self, id: &str, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        match &self.get(id).await?.backend {
            Backend::Mysql(s) => s.tree(path).await,
            Backend::Postgres(s) => s.tree(path).await,
            Backend::ClickHouse(s) => s.tree(path).await,
            Backend::Redis(s) => s.tree(path).await,
            Backend::Mongo(s) => s.tree(path).await,
            Backend::BigQuery(s) => s.tree(path).await,
        }
    }

    pub async fn query(
        &self,
        id: &str,
        database: Option<String>,
        sql: &str,
        limit: usize,
    ) -> anyhow::Result<QueryOutput> {
        let session = self.get(id).await?;
        // Redis tự chặn theo cờ `write` của từng lệnh (xem redis.rs), MongoDB theo
        // phương thức / lệnh (xem mongo.rs).
        if session.read_only && !matches!(session.backend, Backend::Redis(_) | Backend::Mongo(_)) {
            ensure_read_only(sql)?;
        }
        let started = Instant::now();
        let database = database.filter(|d| !d.trim().is_empty());
        let (results, database) = match &session.backend {
            Backend::Mysql(s) => s.query(database, sql, limit).await?,
            Backend::Postgres(s) => s.query(database, sql, limit).await?,
            Backend::ClickHouse(s) => s.query(database, sql, limit).await?,
            Backend::Redis(s) => s.query(database, sql, limit).await?,
            Backend::Mongo(s) => s.query(database, sql, limit).await?,
            Backend::BigQuery(s) => s.query(database, sql, limit).await?,
        };
        Ok(QueryOutput { results, elapsed_ms: started.elapsed().as_millis() as u64, database })
    }

    /// Đo chỉ số cho màn Monitor.
    pub async fn monitor(&self, id: &str, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        match &self.get(id).await?.backend {
            Backend::Mysql(s) => s.monitor(breakdown).await,
            Backend::Postgres(s) => s.monitor(breakdown).await,
            Backend::ClickHouse(s) => s.monitor(breakdown).await,
            Backend::Redis(s) => s.monitor(breakdown).await,
            Backend::Mongo(s) => s.monitor(breakdown).await,
            Backend::BigQuery(s) => s.monitor(breakdown).await,
        }
    }

    /// Dung lượng + số dòng từng bảng của một database.
    pub async fn table_sizes(&self, id: &str, database: &str) -> anyhow::Result<TableSizes> {
        match &self.get(id).await?.backend {
            Backend::Mysql(s) => s.table_sizes(database).await,
            Backend::Postgres(s) => s.table_sizes(database).await,
            Backend::ClickHouse(s) => s.table_sizes(database).await,
            Backend::Redis(_) => anyhow::bail!("Redis has no tables"),
            Backend::Mongo(s) => s.table_sizes(database).await,
            Backend::BigQuery(s) => s.table_sizes(database).await,
        }
    }

    /// Huỷ một query / client đang chạy (id lấy từ bảng hoạt động của Monitor).
    /// Kết nối read-only không được phép.
    pub async fn monitor_kill(&self, id: &str, target: &str) -> anyhow::Result<()> {
        let session = self.get(id).await?;
        if session.read_only {
            anyhow::bail!("Read-only connection — killing queries is disabled.");
        }
        match &session.backend {
            Backend::Mysql(s) => s.kill(target).await,
            Backend::Postgres(s) => s.kill(target).await,
            Backend::ClickHouse(s) => s.kill(target).await,
            Backend::Redis(s) => s.kill(target).await,
            Backend::Mongo(s) => s.kill(target).await,
            Backend::BigQuery(s) => s.kill(target).await,
        }
    }

    /// Huỷ câu lệnh đang chạy của phiên (nếu có).
    pub async fn cancel(&self, id: &str) -> anyhow::Result<()> {
        match &self.get(id).await?.backend {
            Backend::Mysql(s) => s.cancel().await,
            Backend::Postgres(s) => s.cancel().await,
            Backend::ClickHouse(s) => s.cancel().await,
            Backend::Redis(s) => s.cancel().await,
            Backend::Mongo(s) => s.cancel().await,
            Backend::BigQuery(s) => s.cancel().await,
        }
    }
}

/// Bao tên (database/bảng) bằng dấu nháy định danh của MySQL.
fn quote_mysql(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// Tách script thành từng câu lệnh theo `;` ở cấp ngoài cùng (bỏ qua `;` trong
/// chuỗi '…' "…" `…` và comment -- / /* */). Dùng cho DB không nhận nhiều câu
/// trong một lần gửi (ClickHouse HTTP).
fn split_statements(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    let push = |from: usize, to: usize, out: &mut Vec<String>| {
        let t = sql[from..to].trim();
        if !strip_comments(t).trim().is_empty() {
            out.push(t.to_string());
        }
    };
    while i < b.len() {
        match b[i] {
            b'-' if b.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(b.len(), |e| i + e + 1);
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = sql[i + 2..].find("*/").map_or(b.len(), |e| i + 2 + e + 2);
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' && q != b'`' {
                        i += 2;
                    } else if b[i] == q {
                        if b.get(i + 1) == Some(&q) {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            b';' => {
                push(start, i, &mut out);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    push(start, b.len().max(start), &mut out);
    out
}

/// Lớp bảo vệ read-only phía Termez (lớp thứ hai là chế độ read-only của phiên
/// trên server): mỗi câu lệnh phải là câu ĐỌC — SELECT / SHOW / DESCRIBE /
/// EXPLAIN / WITH … SELECT / VALUES / TABLE / USE. Chặn cả `SELECT … INTO`
/// (tạo bảng / ghi file), CTE có INSERT/UPDATE/DELETE, `EXPLAIN ANALYZE` của
/// câu ghi (vì nó thực thi thật) và `SET` (có thể tắt read-only của phiên).
pub fn ensure_read_only(sql: &str) -> anyhow::Result<()> {
    const WRITES: [&str; 5] = ["INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT"];
    for stmt in split_statements(sql) {
        let words = sql_words(&stmt);
        let has = |w: &str| words.iter().any(|x| x == w);
        let writes = || WRITES.iter().any(|w| has(w));
        let first = words.first().map(String::as_str).unwrap_or("");
        let ok = match first {
            "SELECT" | "VALUES" | "TABLE" => !has("INTO"),
            "WITH" => !has("INTO") && !writes(),
            "SHOW" | "DESCRIBE" | "DESC" | "USE" | "EXISTS" | "HELP" => true,
            "EXPLAIN" => !(has("ANALYZE") || has("ANALYSE")) || !(writes() || has("INTO")),
            _ => false,
        };
        if !ok {
            let head: String = stmt.split_whitespace().take(4).collect::<Vec<_>>().join(" ");
            anyhow::bail!(
                "Read-only connection — blocked: `{head}…`\nOnly SELECT / SHOW / DESCRIBE / EXPLAIN statements can run. \
                 Edit the connection and untick Read-only to make changes."
            );
        }
    }
    Ok(())
}

/// Các từ khoá/định danh (chữ hoa) nằm NGOÀI chuỗi, định danh có nháy và comment.
fn sql_words(stmt: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut it = stmt.char_indices().peekable();
    let flush = |cur: &mut String, words: &mut Vec<String>| {
        if !cur.is_empty() {
            words.push(std::mem::take(cur).to_ascii_uppercase());
        }
    };
    while let Some((i, c)) = it.next() {
        match c {
            '\'' | '"' | '`' => {
                flush(&mut cur, &mut words);
                let mut prev_bs = false;
                while let Some((_, d)) = it.next() {
                    if d == c && !prev_bs {
                        if it.peek().map(|&(_, n)| n) == Some(c) {
                            it.next(); // nháy kép thoát ('')
                            continue;
                        }
                        break;
                    }
                    prev_bs = d == '\\' && !prev_bs && c != '`';
                }
            }
            '-' if stmt[i + 1..].starts_with('-') => {
                flush(&mut cur, &mut words);
                while let Some((_, d)) = it.next() {
                    if d == '\n' {
                        break;
                    }
                }
            }
            '/' if stmt[i + 1..].starts_with('*') => {
                flush(&mut cur, &mut words);
                let end = stmt[i + 2..].find("*/").map_or(stmt.len(), |e| i + 2 + e + 2);
                while it.peek().is_some_and(|&(j, _)| j < end) {
                    it.next();
                }
            }
            '$' => {
                // PostgreSQL dollar-quote: $tag$ … $tag$
                flush(&mut cur, &mut words);
                let rest = &stmt[i + 1..];
                if let Some(close) = rest.find('$') {
                    let tag = &rest[..close];
                    if tag.chars().all(|ch| ch.is_alphanumeric() || ch == '_') {
                        let delim = format!("${tag}$");
                        let body_start = i + 1 + close + 1;
                        let end = stmt[body_start..].find(&delim).map_or(stmt.len(), |e| body_start + e + delim.len());
                        while it.peek().is_some_and(|&(j, _)| j < end) {
                            it.next();
                        }
                    }
                }
            }
            c if c.is_alphanumeric() || c == '_' => cur.push(c),
            _ => flush(&mut cur, &mut words),
        }
    }
    flush(&mut cur, &mut words);
    words
}

fn strip_comments(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(p) = rest.find("/*") {
        out.push_str(&rest[..p]);
        rest = rest[p + 2..].find("*/").map_or("", |e| &rest[p + 2 + e + 2..]);
    }
    out.push_str(rest);
    out.lines().map(|l| l.split("--").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

/// Kiểm tra với server thật (bỏ qua mặc định). Ví dụ:
/// `TERMEZ_TEST_MYSQL=127.0.0.1:13306:root:pw TERMEZ_TEST_PG=127.0.0.1:15432:postgres:pw \
///  cargo test dbclient -- --ignored`
#[cfg(test)]
mod tests {
    use super::*;

    fn spec(env: &str, kind: &str, database: &str, read_only: bool) -> Option<ConnectSpec> {
        let v = std::env::var(env).ok()?;
        let p: Vec<&str> = v.splitn(4, ':').collect();
        Some(ConnectSpec {
            kind: kind.into(),
            host: p[0].into(),
            port: p[1].parse().unwrap(),
            tls_host: p[0].into(),
            username: p[2].into(),
            password: p[3].into(),
            database: Some(database.into()),
            ssl_mode: "prefer".into(),
            read_only,
            options: None,
        })
    }

    async fn roundtrip(
        spec: ConnectSpec,
        setup: &str,
        big: &str,
        sleep: &'static str,
        path: Vec<String>,
        ro_write: &str,
    ) {
        let m = DbManager::new();
        let info = m.open(spec.clone(), None).await.expect("open");
        assert!(!info.server_version.is_empty());
        let id = info.session_id;

        // Nhiều câu lệnh một lần: tạo bảng, chèn, đọc.
        let out = m.query(&id, None, setup, 1000).await.expect("setup");
        let last = out.results.last().unwrap();
        assert_eq!(last.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name", "note"]);
        assert_eq!(last.rows.len(), 2);
        assert_eq!(last.rows[1], vec![Some("2".into()), Some("bob".into()), None]);
        assert!(out.results.iter().any(|r| r.affected == Some(2)), "INSERT báo 2 dòng");
        let dbs = list_databases(&spec).await.expect("list databases");
        assert!(dbs.contains(&path[0]), "thiếu {} trong {dbs:?}", path[0]);
        let sizes = m.table_sizes(&id, &path[0]).await.expect("table sizes");
        let t = sizes
            .tables
            .iter()
            .find(|t| t.name == "t" || t.name.ends_with(".t"))
            .unwrap_or_else(|| panic!("thiếu bảng t: {:?}", sizes.tables.iter().map(|t| &t.name).collect::<Vec<_>>()));
        if sizes.rows_exact {
            assert_eq!(t.rows, Some(2.0), "ClickHouse đếm chính xác");
        }

        // Giới hạn dòng → truncated, không lỗi.
        let out = m.query(&id, None, big, 10).await.expect("big");
        assert_eq!(out.results[0].rows.len(), 10);
        assert!(out.results[0].truncated);

        // Cây schema tới cột.
        let mut p: Vec<String> = Vec::new();
        for (i, want) in path.iter().enumerate() {
            let nodes = m.tree(&id, &p).await.expect("tree");
            assert!(nodes.iter().any(|n| &n.name == want), "level {i}: thiếu {want}");
            p.push(want.clone());
        }
        let cols = m.tree(&id, &p).await.expect("columns");
        assert_eq!(cols[0].name, "id");
        assert!(cols[0].detail.as_deref().unwrap_or("").contains("PK"));

        // Huỷ câu lệnh dài.
        let m = std::sync::Arc::new(m);
        let (m2, id2) = (m.clone(), id.clone());
        let t = tokio::spawn(async move { m2.query(&id2, None, sleep, 10).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        m.cancel(&id).await.expect("cancel");
        let started = Instant::now();
        let _ = t.await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "cancel không có tác dụng");

        // Read-only: ghi phải bị từ chối.
        let ro = DbManager::new();
        let rid = ro.open(ConnectSpec { read_only: true, ..spec }, None).await.unwrap().session_id;
        assert!(ro.query(&rid, None, ro_write, 10).await.is_err(), "read-only cho phép ghi");
        m.close(&id).await;
    }

    #[tokio::test]
    #[ignore]
    async fn mysql_roundtrip() {
        let Some(s) = spec("TERMEZ_TEST_MYSQL", "mysql", "shop", false) else { return };
        // "prefer" + MySQL 8 (chứng chỉ tự ký) → phải đi qua TLS.
        let m = DbManager::new();
        let id = m.open(s.clone(), None).await.unwrap().session_id;
        let out = m.query(&id, None, "SHOW SESSION STATUS LIKE 'Ssl_cipher'", 10).await.unwrap();
        assert!(!out.results[0].rows[0][1].clone().unwrap_or_default().is_empty(), "không dùng TLS");
        roundtrip(
            s,
            "DROP TABLE IF EXISTS t; CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20), note TEXT); \
             INSERT INTO t (id, name) VALUES (1, 'ann'), (2, 'bob'); SELECT * FROM t ORDER BY id",
            "SELECT a.COLUMN_NAME FROM information_schema.COLUMNS a CROSS JOIN information_schema.COLUMNS b LIMIT 5000",
            "SELECT SLEEP(10)",
            vec!["shop".into(), "t".into()],
            "INSERT INTO t (id, name) VALUES (9, 'x')",
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn postgres_roundtrip() {
        let Some(s) = spec("TERMEZ_TEST_PG", "postgres", "shop", false) else { return };
        roundtrip(
            s,
            "DROP TABLE IF EXISTS t; CREATE TABLE t (id INT PRIMARY KEY, name TEXT, note TEXT); \
             INSERT INTO t (id, name) VALUES (1, 'ann'), (2, 'bob'); SELECT * FROM t ORDER BY id",
            "SELECT g FROM generate_series(1, 5000000) g",
            "SELECT pg_sleep(10)",
            vec!["shop".into(), "public".into(), "t".into()],
            "INSERT INTO t (id, name) VALUES (9, 'x')",
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn clickhouse_roundtrip() {
        let Some(s) = spec("TERMEZ_TEST_CH", "clickhouse", "default", false) else { return };
        // Profile bật query cache → ClickHouse cấm result_overflow_mode=break (lỗi 731);
        // phải tự bỏ giới hạn phía server và vẫn cắt đúng số dòng.
        let m = DbManager::new();
        let id = m.open(s.clone(), None).await.unwrap().session_id;
        m.query(&id, None, "SET use_query_cache = 1", 10).await.expect("set");
        let out = m.query(&id, None, "SELECT number FROM numbers(100000)", 10).await.expect("query cache + limit");
        assert_eq!(out.results[0].rows.len(), 10);
        assert!(out.results[0].truncated);
        roundtrip(
            s,
            "CREATE DATABASE IF NOT EXISTS shop; DROP TABLE IF EXISTS shop.t; \
             CREATE TABLE shop.t (id Int32, name String, note Nullable(String)) ENGINE = MergeTree ORDER BY id; \
             INSERT INTO shop.t (id, name) VALUES (1, 'ann'), (2, 'bob'); SELECT * FROM shop.t ORDER BY id",
            "SELECT number FROM numbers(5000000)",
            "SELECT sleepEachRow(0.5) FROM numbers(60) SETTINGS max_block_size = 1",
            vec!["shop".into(), "t".into()],
            "INSERT INTO shop.t (id, name) VALUES (9, 'x')",
        )
        .await;
    }

    /// Profile bật query cache (use_query_cache=1): câu nội bộ có version()/uptime()
    /// không được lỗi 704; câu của người dùng có now() chạy lại không dùng cache.
    #[tokio::test]
    #[ignore]
    async fn clickhouse_query_cache_profile() {
        let Some(admin) = spec("TERMEZ_TEST_CH", "clickhouse", "default", false) else { return };
        let m = DbManager::new();
        let aid = m.open(admin.clone(), None).await.unwrap().session_id;
        for q in [
            "CREATE SETTINGS PROFILE IF NOT EXISTS termez_qc SETTINGS use_query_cache = 1",
            "CREATE USER IF NOT EXISTS termez_qc IDENTIFIED BY 'qcpass' SETTINGS PROFILE 'termez_qc'",
            "GRANT SELECT, SHOW, KILL QUERY ON *.* TO termez_qc",
        ] {
            if let Err(e) = m.query(&aid, None, q, 10).await {
                eprintln!("bỏ qua: server không cho quản lý user bằng SQL ({e})");
                return;
            }
        }
        let qc = ConnectSpec { username: "termez_qc".into(), password: "qcpass".into(), read_only: true, ..admin };
        let info = m.open(qc.clone(), None).await.expect("kết nối (SELECT version()) không được lỗi 704");
        let id = info.session_id;
        assert!(!m.tree(&id, &[]).await.unwrap().is_empty());
        let snap = m.monitor(&id, true).await.expect("monitor");
        assert!(snap.values.contains_key("a_Uptime"));
        let out = m.query(&id, None, "SELECT now() AS t", 10).await.expect("now() trong editor");
        assert_eq!(out.results[0].rows.len(), 1);
        let out = m.query(&id, None, "SELECT number FROM numbers(1000)", 10).await.expect("giới hạn dòng");
        assert_eq!(out.results[0].rows.len(), 10);
        assert!(out.results[0].truncated);
        assert!(list_databases(&qc).await.is_ok());
        let _ = m.query(&aid, None, "DROP USER IF EXISTS termez_qc", 10).await;
        let _ = m.query(&aid, None, "DROP SETTINGS PROFILE IF EXISTS termez_qc", 10).await;
    }

    #[tokio::test]
    #[ignore]
    async fn redis_roundtrip() {
        let Some(s) = spec("TERMEZ_TEST_REDIS", "redis", "0", false) else { return };
        let m = DbManager::new();
        let info = m.open(s.clone(), None).await.expect("open");
        assert!(info.server_version.starts_with('7'), "version {}", info.server_version);
        assert!(list_databases(&s).await.unwrap().contains(&"0".to_string()));
        let id = info.session_id;
        let out = m
            .query(&id, None, "FLUSHDB\nSET greeting \"hello world\"\nGET greeting\nHSET user:1 name ann age 30\nHGETALL user:1\nGET missing", 100)
            .await
            .expect("cmds");
        assert_eq!(out.results[2].rows, vec![vec![Some("hello world".to_string())]]);
        assert_eq!(out.results[4].columns[0].name, "field");
        assert_eq!(out.results[4].rows.len(), 2);
        assert_eq!(out.results[5].rows, vec![vec![None]]);

        let dbs = m.tree(&id, &[]).await.expect("dbs");
        assert!(dbs.iter().any(|n| n.name == "db0" && n.detail.as_deref() == Some("2 keys")));
        let keys = m.tree(&id, &["db0".to_string()]).await.expect("keys");
        assert_eq!(
            keys.iter().map(|k| (k.name.as_str(), k.detail.as_deref().unwrap())).collect::<Vec<_>>(),
            [("greeting", "string"), ("user:1", "hash")]
        );

        // Lệnh chặn huỷ được.
        let m = std::sync::Arc::new(m);
        let (m2, id2) = (m.clone(), id.clone());
        let t = tokio::spawn(async move { m2.query(&id2, None, "BLPOP nothing 30", 10).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        m.cancel(&id).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(3), t).await.is_ok(), "BLPOP không huỷ được");
        // Kết nối dùng lại được sau khi huỷ.
        assert!(m.query(&id, None, "PING", 10).await.is_ok());

        let ro = DbManager::new();
        let rid = ro.open(ConnectSpec { read_only: true, ..s }, None).await.unwrap().session_id;
        assert!(ro.query(&rid, None, "GET greeting", 10).await.is_ok());
        assert!(ro.query(&rid, None, "SET greeting x", 10).await.is_err(), "read-only cho phép SET");
    }

    #[test]
    fn split_statements_respects_quotes_and_comments() {
        let v = split_statements("SELECT ';' AS a; -- x;\nSELECT 2 /* ; */;\n/* only comment */ ; SELECT `a;b`");
        assert_eq!(v, ["SELECT ';' AS a", "-- x;\nSELECT 2 /* ; */", "SELECT `a;b`"]);
    }


    #[test]
    fn read_only_guard() {
        for ok in [
            "SELECT * FROM t WHERE note = 'DELETE me; INSERT'",
            "select 1; show tables; describe t; explain select * from t",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SELECT * FROM t FOR UPDATE",
            "EXPLAIN ANALYZE SELECT * FROM t",
            "USE shop",
            "SELECT $$ drop table x $$",
            "/* UPDATE */ SELECT `update` FROM t -- DELETE",
        ] {
            assert!(ensure_read_only(ok).is_ok(), "nên cho phép: {ok}");
        }
        for bad in [
            "UPDATE t SET a = 1",
            "insert into t values (1)",
            "SELECT 1; DELETE FROM t",
            "DROP TABLE t",
            "TRUNCATE t",
            "CREATE TABLE x (a int)",
            "ALTER TABLE t ADD COLUMN b int",
            "SELECT * INTO backup FROM t",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
            "EXPLAIN ANALYZE UPDATE t SET a = 1",
            "SET SESSION TRANSACTION READ WRITE",
            "SET default_transaction_read_only = off",
            "GRANT ALL ON t TO u",
            "CALL p()",
            "  -- c\n  REPLACE INTO t VALUES (1)",
        ] {
            assert!(ensure_read_only(bad).is_err(), "phải chặn: {bad}");
        }
    }


    /// Monitor: có đủ chỉ số; một query dài ở phiên khác hiện trong bảng hoạt động
    /// và huỷ được bằng monitor_kill; phiên read-only không được kill.
    async fn monitor_roundtrip(spec: ConnectSpec, keys: &[&str], long: &'static str, marker: &str) {
        let m = std::sync::Arc::new(DbManager::new());
        let mon = m.open(spec.clone(), None).await.unwrap().session_id;
        let snap = m.monitor(&mon, true).await.expect("monitor");
        for k in keys {
            assert!(snap.values.contains_key(*k), "thiếu chỉ số {k}: {:?}", snap.values.keys().collect::<Vec<_>>());
        }
        assert!(snap.breakdown.is_some(), "thiếu breakdown");

        let worker = m.open(spec.clone(), None).await.unwrap().session_id;
        let (m2, w2) = (m.clone(), worker.clone());
        let started = Instant::now();
        let job = tokio::spawn(async move { m2.query(&w2, None, long, 10).await });
        // Chờ query dài xuất hiện trong bảng hoạt động rồi kill.
        let mut target = None;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            let snap = m.monitor(&mon, false).await.unwrap();
            target = snap.tables[0]
                .rows
                .iter()
                .find(|r| r.cells.iter().flatten().any(|c| c.contains(marker)))
                .and_then(|r| r.id.clone());
            if target.is_some() {
                break;
            }
        }
        let target = target.expect("không thấy query dài trong bảng hoạt động");
        m.monitor_kill(&mon, &target).await.expect("kill");
        let _ = tokio::time::timeout(Duration::from_secs(5), job).await.expect("query không dừng sau khi kill");
        assert!(started.elapsed() < Duration::from_secs(8));

        let ro = m.open(ConnectSpec { read_only: true, ..spec }, None).await.unwrap().session_id;
        assert!(m.monitor(&ro, false).await.is_ok(), "read-only vẫn xem được monitor");
        assert!(m.monitor_kill(&ro, &target).await.is_err(), "read-only không được kill");
    }

    #[tokio::test]
    #[ignore]
    async fn monitor_mysql() {
        let Some(s) = spec("TERMEZ_TEST_MYSQL", "mysql", "shop", false) else { return };
        monitor_roundtrip(s, &["Questions", "Threads_connected", "Bytes_received", "max_connections"], "SELECT SLEEP(30) AS termez_mon", "termez_mon").await;
    }

    #[tokio::test]
    #[ignore]
    async fn monitor_postgres() {
        let Some(s) = spec("TERMEZ_TEST_PG", "postgres", "shop", false) else { return };
        monitor_roundtrip(s, &["xact_commit", "blks_hit", "sessions_total", "locks_waiting", "uptime"], "SELECT pg_sleep(30) AS termez_mon", "termez_mon").await;
    }

    #[tokio::test]
    #[ignore]
    async fn monitor_clickhouse() {
        let Some(s) = spec("TERMEZ_TEST_CH", "clickhouse", "default", false) else { return };
        monitor_roundtrip(
            s,
            &["ev_Query", "m_MemoryTracking", "a_Uptime"],
            "SELECT sleepEachRow(0.5) AS termez_mon FROM numbers(60) SETTINGS max_block_size = 1",
            "termez_mon",
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_roundtrip() {
        let Some(s) = spec("TERMEZ_TEST_MONGO", "mongodb", "shop", false) else { return };
        let m = std::sync::Arc::new(DbManager::new());
        let info = m.open(s.clone(), None).await.expect("open");
        assert!(!info.server_version.is_empty());
        assert_eq!(info.database.as_deref(), Some("shop"));
        let id = info.session_id;
        let out = m
            .query(
                &id,
                None,
                "db.t.drop()\ndb.t.insertMany([{ _id: 1, name: 'ann', tags: ['a'] }, { _id: 2, name: 'bob', at: ISODate('2026-10-01') }])\n\
                 db.t.find({}).sort({ _id: 1 })",
                1000,
            )
            .await
            .expect("script");
        assert_eq!(out.results[1].affected, Some(2));
        let last = out.results.last().unwrap();
        assert_eq!(last.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["_id", "name", "tags", "at"]);
        assert_eq!(last.rows[0][2].as_deref(), Some("[\"a\"]"));
        assert_eq!(last.rows[1][3].as_deref(), Some("2026-10-01T00:00:00Z"));
        let out = m.query(&id, None, "db.t.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }])", 10).await.unwrap();
        assert_eq!(out.results[0].rows[0][1].as_deref(), Some("2"));
        let out = m.query(&id, None, "use other; show collections; use shop", 10).await.unwrap();
        assert_eq!(out.database.as_deref(), Some("shop"));

        // Giới hạn dòng.
        let docs: Vec<String> = (0..30).map(|i| format!("{{ k: {i} }}")).collect();
        m.query(&id, None, &format!("db.big.drop(); db.big.insertMany([{}])", docs.join(",")), 10).await.unwrap();
        let out = m.query(&id, None, "db.big.find()", 10).await.unwrap();
        assert_eq!(out.results[0].rows.len(), 10);
        assert!(out.results[0].truncated);

        assert!(list_databases(&s).await.unwrap().contains(&"shop".to_string()));
        let colls = m.tree(&id, &["shop".into()]).await.unwrap();
        assert!(colls.iter().any(|n| n.name == "t" && n.kind == "collection"));
        let fields = m.tree(&id, &["shop".into(), "t".into()]).await.unwrap();
        assert_eq!(fields[0].name, "_id");
        let sizes = m.table_sizes(&id, "shop").await.unwrap();
        assert_eq!(sizes.tables.iter().find(|t| t.name == "t").and_then(|t| t.rows), Some(2.0));

        // Huỷ lệnh dài ($where + sleep).
        let (m2, id2) = (m.clone(), id.clone());
        let t = tokio::spawn(async move { m2.query(&id2, None, "db.t.find({ $where: 'sleep(15000) || true' })", 10).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        m.cancel(&id).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(3), t).await.is_ok(), "cancel không có tác dụng");

        // Read-only.
        let ro = m.open(ConnectSpec { read_only: true, ..s.clone() }, None).await.unwrap().session_id;
        assert!(m.query(&ro, None, "db.t.find({})", 10).await.is_ok());
        for w in [
            "db.t.insertOne({ x: 1 })",
            "db.t.deleteMany({})",
            "db.t.aggregate([{ $out: 'copy' }])",
            "db.runCommand({ drop: 't' })",
            "db.dropDatabase()",
        ] {
            assert!(m.query(&ro, None, w, 10).await.is_err(), "read-only cho phép: {w}");
        }
        assert!(m.query(&ro, None, "db.runCommand({ ping: 1 })", 10).await.is_ok());
    }

    /// DROP DATABASE khi phiên đang giữ client tới database đó (PostgreSQL).
    #[tokio::test]
    #[ignore]
    async fn postgres_drop_database_in_use_by_session() {
        let Some(s) = spec("TERMEZ_TEST_PG", "postgres", "shop", false) else { return };
        let m = DbManager::new();
        let id = m.open(s, None).await.unwrap().session_id;
        let _ = m.query(&id, None, "DROP DATABASE IF EXISTS termez_drop", 10).await;
        m.query(&id, None, "CREATE DATABASE termez_drop", 10).await.expect("create");
        m.query(&id, Some("termez_drop".into()), "CREATE TABLE t (id int)", 10).await.expect("use new db");
        assert!(m.query(&id, Some("termez_drop".into()), "DROP DATABASE termez_drop", 10).await.is_err(), "không chạy từ chính nó");
        m.query(&id, None, "DROP DATABASE \"termez_drop\";", 10).await.expect("drop while cached");
        let dbs = m.tree(&id, &[]).await.unwrap();
        assert!(!dbs.iter().any(|n| n.name == "termez_drop"));
    }

    #[tokio::test]
    #[ignore]
    async fn mongo_ddl() {
        let Some(s) = spec("TERMEZ_TEST_MONGO", "mongodb", "shop", false) else { return };
        let m = DbManager::new();
        let id = m.open(s, None).await.unwrap().session_id;
        let db = Some("termez_ddl".to_string());
        let _ = m.query(&id, db.clone(), "db.dropDatabase()", 10).await;
        m.query(&id, db.clone(), "db.createCollection(\"people\")", 10).await.expect("create collection");
        let out = m
            .query(&id, db.clone(), "db.people.createIndex({ email: 1, age: -1 }, { name: \"uq_email\", unique: true })", 10)
            .await
            .expect("create index");
        assert_eq!(out.results[0].rows[0][0].as_deref(), Some("uq_email"));
        let out = m.query(&id, db.clone(), "db.people.getIndexes()", 10).await.unwrap();
        let names: Vec<_> = out.results[0].columns.iter().map(|c| c.name.as_str()).collect();
        let ni = names.iter().position(|c| *c == "name").expect("name column");
        let ui = names.iter().position(|c| *c == "unique").expect("unique column");
        let row = out.results[0].rows.iter().find(|r| r[ni].as_deref() == Some("uq_email")).expect("index listed");
        assert_eq!(row[ui].as_deref(), Some("true"));
        assert!(m.query(&id, db.clone(), "db.people.insertMany([{ email: 'a' }, { email: 'a' }])", 10).await.is_err(), "unique");
        m.query(&id, db.clone(), "db.people.dropIndex(\"uq_email\")", 10).await.expect("drop index");
        m.query(&id, db.clone(), "db.dropDatabase()", 10).await.expect("drop db");
    }

    #[tokio::test]
    #[ignore]
    async fn monitor_mongo() {
        let Some(s) = spec("TERMEZ_TEST_MONGO", "mongodb", "shop", false) else { return };
        let m = DbManager::new();
        let id = m.open(s.clone(), None).await.unwrap().session_id;
        m.query(&id, None, "db.mon.drop(); db.mon.insertMany([{ a: 1 }, { a: 2 }])", 10).await.unwrap();
        monitor_roundtrip(
            s,
            &["op_query", "op_insert", "conn_current", "net_in", "uptime"],
            "db.mon.find({ $where: \"sleep(15000) || 'termez_mon'\" })",
            "termez_mon",
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn monitor_redis() {
        let Some(s) = spec("TERMEZ_TEST_REDIS", "redis", "0", false) else { return };
        // Client chặn ở BLPOP hiện trong CLIENT LIST (cmd=blpop) và bị CLIENT KILL.
        monitor_roundtrip(s, &["total_commands_processed", "used_memory", "connected_clients", "uptime_in_seconds"], "BLPOP termez_mon 30", "blpop").await;
    }

}
