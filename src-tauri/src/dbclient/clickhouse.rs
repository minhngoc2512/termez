//! ClickHouse qua HTTP interface (cổng 8123 / HTTPS 8443) bằng `reqwest` sẵn có.
//!
//! - Kết quả ở định dạng `JSONCompactEachRowWithNamesAndTypes` (mỗi dòng một mảng
//!   JSON), đọc dạng stream; giới hạn dòng đặt luôn phía server
//!   (`max_result_rows` + `result_overflow_mode=break`).
//! - HTTP chỉ chạy một câu mỗi request → script được tách theo `;`.
//! - Câu lệnh của editor chạy trong một HTTP session (giữ SET / bảng tạm); cây
//!   schema và lệnh huỷ dùng request riêng (session bị khoá khi đang chạy).

use super::{split_statements, Column, ConnectSpec, ResultSet, TreeNode};
use futures_util::StreamExt;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

pub struct ChSession {
    http: reqwest::Client,
    base: String,
    user: String,
    password: String,
    default_db: Option<String>,
    read_only: bool,
    session_id: String,
    /// query_id của câu đang chạy (để KILL QUERY).
    running: std::sync::Mutex<Option<String>>,
}

fn build_client(spec: &ConnectSpec, https: bool) -> anyhow::Result<(reqwest::Client, String)> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));
    if https && spec.ssl_mode != "verify" {
        b = b.danger_accept_invalid_certs(true);
    }
    // Qua tunnel: URL giữ tên host thật (cho TLS/SNI) nhưng phân giải về cổng local.
    let url_host = if spec.tls_host != spec.host && spec.tls_host.parse::<IpAddr>().is_err() {
        b = b.resolve(&spec.tls_host, SocketAddr::new(spec.host.parse()?, spec.port));
        spec.tls_host.clone()
    } else {
        spec.host.clone()
    };
    let host = if url_host.contains(':') { format!("[{url_host}]") } else { url_host };
    let scheme = if https { "https" } else { "http" };
    Ok((b.build()?, format!("{scheme}://{host}:{}/", spec.port)))
}

impl ChSession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        // "prefer": thử HTTPS trước, lỗi kết nối/TLS thì dùng HTTP thường.
        let tries: &[bool] = match spec.ssl_mode.as_str() {
            "disable" => &[false],
            "require" | "verify" => &[true],
            _ => &[true, false],
        };
        let mut last_err = None;
        for &https in tries {
            let (http, base) = build_client(spec, https)?;
            let s = Self {
                http,
                base,
                user: spec.username.clone(),
                password: spec.password.clone(),
                default_db: spec.database.clone().filter(|d| !d.is_empty()),
                read_only: spec.read_only,
                session_id: uuid::Uuid::new_v4().to_string(),
                running: std::sync::Mutex::new(None),
            };
            match s.scalar("SELECT version()").await {
                Ok(v) => return Ok((s, v)),
                // Server đã trả lời (sai mật khẩu…) → đừng thử HTTP nữa.
                Err(e) if e.downcast_ref::<reqwest::Error>().is_none() => return Err(e),
                Err(e) => last_err = Some(e),
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("không kết nối được")))
    }

    pub fn default_database(&self) -> Option<String> {
        self.default_db.clone()
    }

    fn request(&self, sql: &str, params: &[(&str, String)]) -> reqwest::RequestBuilder {
        let mut q: Vec<(&str, String)> = vec![
            ("default_format", "JSONCompactEachRowWithNamesAndTypes".into()),
            ("output_format_json_quote_64bit_integers", "0".into()),
        ];
        if self.read_only {
            q.push(("readonly", "2".into()));
        }
        q.extend(params.iter().cloned());
        self.http
            .post(&self.base)
            .query(&q)
            .header("X-ClickHouse-User", &self.user)
            .header("X-ClickHouse-Key", &self.password)
            .body(sql.to_string())
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> anyhow::Result<reqwest::Response> {
        let resp = req.send().await?;
        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("{}", text.trim());
        }
        Ok(resp)
    }

    /// Câu lệnh nhỏ (metadata): đọc toàn bộ thành các dòng giá trị.
    async fn rows(&self, sql: &str, params: &[(&str, String)]) -> anyhow::Result<Vec<Vec<Option<String>>>> {
        let resp = self.send(self.request(sql, params)).await?;
        let body = resp.text().await?;
        Ok(parse_body(&body, usize::MAX)?.rows)
    }

    async fn scalar(&self, sql: &str) -> anyhow::Result<String> {
        Ok(self
            .rows(sql, &[])
            .await?
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next().flatten())
            .unwrap_or_default())
    }

    pub async fn query(
        &self,
        database: Option<String>,
        sql: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        let db = database.or_else(|| self.default_db.clone());
        let mut sets = Vec::new();
        for stmt in split_statements(sql) {
            let query_id = uuid::Uuid::new_v4().to_string();
            *self.running.lock().unwrap() = Some(query_id.clone());
            let res = self.run_one(&stmt, db.clone(), limit, &query_id).await;
            *self.running.lock().unwrap() = None;
            sets.push(res?);
        }
        Ok((sets, db))
    }

    async fn run_one(
        &self,
        stmt: &str,
        db: Option<String>,
        limit: usize,
        query_id: &str,
    ) -> anyhow::Result<ResultSet> {
        let mut params = vec![
            ("session_id", self.session_id.clone()),
            ("session_timeout", "3600".to_string()),
            ("query_id", query_id.to_string()),
            ("max_result_rows", (limit + 1).to_string()),
            ("result_overflow_mode", "break".to_string()),
        ];
        if let Some(db) = db {
            params.push(("database", db));
        }
        let resp = self.send(self.request(stmt, &params)).await?;
        let written = resp
            .headers()
            .get("X-ClickHouse-Summary")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v["written_rows"].as_str().and_then(|n| n.parse::<u64>().ok()));

        // Đọc stream; đủ giới hạn thì dừng (bỏ phần còn lại).
        let mut body = Vec::new();
        let mut lines = 0usize;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            lines += chunk.iter().filter(|&&c| c == b'\n').count();
            body.extend_from_slice(&chunk);
            if lines > limit + 2 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&body);
        if text.trim().is_empty() {
            return Ok(ResultSet { affected: Some(written.unwrap_or(0)), ..Default::default() });
        }
        parse_body(&text, limit)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        let id = self.running.lock().unwrap().clone();
        if let Some(id) = id {
            self.send(self.request(&format!("KILL QUERY WHERE query_id = '{id}' ASYNC"), &[]))
                .await?;
        }
        Ok(())
    }

    /// Cây: [] → databases; [db] → bảng/view; [db, bảng] → cột.
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        let node = |name: String, kind: &str, detail: Option<String>, leaf: bool| TreeNode {
            name,
            kind: kind.into(),
            detail,
            leaf,
        };
        Ok(match path {
            [] => self
                .rows("SELECT name FROM system.databases ORDER BY name", &[])
                .await?
                .into_iter()
                .map(|r| node(cell(&r, 0), "database", None, false))
                .collect(),
            [db] => self
                .rows(
                    "SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name",
                    &[("param_db", db.clone())],
                )
                .await?
                .into_iter()
                .map(|r| {
                    let engine = cell(&r, 1);
                    let kind = if engine.contains("View") { "view" } else { "table" };
                    node(cell(&r, 0), kind, Some(engine), false)
                })
                .collect(),
            [db, table] => self
                .rows(
                    "SELECT name, type, is_in_primary_key FROM system.columns \
                     WHERE database = {db:String} AND table = {t:String} ORDER BY position",
                    &[("param_db", db.clone()), ("param_t", table.clone())],
                )
                .await?
                .into_iter()
                .map(|r| {
                    let ty = cell(&r, 1);
                    let pk = cell(&r, 2) == "1";
                    node(cell(&r, 0), "column", Some(if pk { format!("{ty} · PK") } else { ty }), true)
                })
                .collect(),
            _ => Vec::new(),
        })
    }
}

fn cell(r: &[Option<String>], i: usize) -> String {
    r.get(i).cloned().flatten().unwrap_or_default()
}

/// Thân trả về: dòng 1 = tên cột, dòng 2 = kiểu, sau đó mỗi dòng một bản ghi.
/// Câu lệnh có FORMAT riêng (vd `FORMAT Pretty`) → trả nguyên văn trong một ô.
fn parse_body(text: &str, limit: usize) -> anyhow::Result<ResultSet> {
    let mut lines = text.lines();
    let names: Option<Vec<String>> = lines.next().and_then(|l| serde_json::from_str(l).ok());
    let types: Option<Vec<String>> = names.as_ref().and_then(|_| lines.next()).and_then(|l| serde_json::from_str(l).ok());
    let (Some(names), Some(types)) = (names, types) else {
        if text.starts_with("Code:") {
            anyhow::bail!("{}", text.trim());
        }
        return Ok(ResultSet {
            columns: vec![Column { name: "result".into(), type_name: None }],
            rows: vec![vec![Some(text.trim_end().to_string())]],
            ..Default::default()
        });
    };
    let mut set = ResultSet {
        columns: names
            .into_iter()
            .zip(types)
            .map(|(name, t)| Column { name, type_name: Some(t) })
            .collect(),
        ..Default::default()
    };
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(vals) = serde_json::from_str::<Vec<serde_json::Value>>(line) else {
            // Lỗi giữa chừng: ClickHouse chèn "Code: … DB::Exception" vào luồng.
            if line.contains("Exception") {
                anyhow::bail!("{}", line.trim());
            }
            break; // dòng cuối bị cắt khi dừng đọc sớm
        };
        if set.rows.len() >= limit {
            set.truncated = true;
            break;
        }
        set.rows.push(
            vals.into_iter()
                .map(|v| match v {
                    serde_json::Value::Null => None,
                    serde_json::Value::String(s) => Some(s),
                    other => Some(other.to_string()),
                })
                .collect(),
        );
    }
    Ok(set)
}
