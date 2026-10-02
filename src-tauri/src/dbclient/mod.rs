//! Client database cho mục Databases (MySQL/MariaDB, PostgreSQL; các loại khác thêm sau).
//!
//! Mỗi lần mở một kết nối đã lưu = một PHIÊN giữ trong `DbManager` cho tới khi pane
//! đóng. Nếu kết nối đi qua SSH, phiên giữ luôn tunnel (cổng local ngẫu nhiên) và
//! driver kết nối vào 127.0.0.1:<cổng đó>; TLS vẫn kiểm tra theo tên host thật.

mod mysql;
mod postgres;
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
    /// "mysql" | "mariadb" | "postgres"
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
    /// "database" | "schema" | "table" | "view" | "column"
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
}

enum Backend {
    Mysql(mysql::MySession),
    Postgres(postgres::PgSession),
}

struct Session {
    backend: Backend,
    tunnel: Option<AbortHandle>,
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
            other => anyhow::bail!("Loại database chưa hỗ trợ: {other}"),
        }
    };
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| anyhow::anyhow!("Hết thời gian chờ kết nối ({}s)", CONNECT_TIMEOUT.as_secs()))?
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
        };
        self.sessions
            .lock()
            .await
            .insert(id.clone(), Arc::new(Session { backend, tunnel }));
        Ok(SessionInfo { session_id: id, kind: spec.kind, database, server_version })
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
        let started = Instant::now();
        let database = database.filter(|d| !d.trim().is_empty());
        let (results, database) = match &session.backend {
            Backend::Mysql(s) => s.query(database, sql, limit).await?,
            Backend::Postgres(s) => s.query(database, sql, limit).await?,
        };
        Ok(QueryOutput { results, elapsed_ms: started.elapsed().as_millis() as u64, database })
    }

    /// Huỷ câu lệnh đang chạy của phiên (nếu có).
    pub async fn cancel(&self, id: &str) -> anyhow::Result<()> {
        match &self.get(id).await?.backend {
            Backend::Mysql(s) => s.cancel().await,
            Backend::Postgres(s) => s.cancel().await,
        }
    }
}

/// Bao tên (database/bảng) bằng dấu nháy định danh của MySQL.
fn quote_mysql(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
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
        })
    }

    async fn roundtrip(spec: ConnectSpec, setup: &str, big: &str, sleep: &'static str, path: Vec<String>) {
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
        assert!(ro.query(&rid, None, "INSERT INTO t (id, name) VALUES (9, 'x')", 10).await.is_err());
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
        )
        .await;
    }
}
