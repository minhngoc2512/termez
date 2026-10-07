//! ClickHouse qua HTTP interface (cổng 8123 / HTTPS 8443) bằng `reqwest` sẵn có.
//!
//! - Kết quả ở định dạng `JSONCompactEachRowWithNamesAndTypes` (mỗi dòng một mảng
//!   JSON), đọc dạng stream; giới hạn dòng đặt luôn phía server
//!   (`max_result_rows` + `result_overflow_mode=break`). Server bật query cache thì
//!   ClickHouse cấm `break` (lỗi 731) → bỏ hai thiết lập đó, chỉ cắt phía client.
//! - Câu lệnh nội bộ (kiểm tra kết nối, cây schema, Monitor…) luôn tắt query cache:
//!   profile bật cache sẽ từ chối câu có hàm không tất định như version()/uptime()
//!   (lỗi 704), và số liệu Monitor phải là số mới. Câu của người dùng giữ nguyên
//!   cache; chỉ khi gặp lỗi 704 mới chạy lại một lần với cache tắt.
//! - HTTP chỉ chạy một câu mỗi request → script được tách theo `;`.
//! - Câu lệnh của editor chạy trong một HTTP session (giữ SET / bảng tạm); cây
//!   schema và lệnh huỷ dùng request riêng (session bị khoá khi đang chạy).

use super::{num, split_statements, Column, ConnectSpec, MonitorRow, MonitorSnapshot, MonitorTable, ResultSet, TableSizes, TableStat, TreeNode};
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
    /// Còn dùng giới hạn dòng phía server không (tắt khi server bật query cache).
    server_limit: std::sync::atomic::AtomicBool,
    /// Được phép gửi `use_query_cache=0` không (user không được đổi setting → thôi gửi).
    cache_off: std::sync::atomic::AtomicBool,
}

/// Server từ chối đổi setting (user readonly=1 hoặc có constraint).
fn is_setting_denied(e: &anyhow::Error) -> bool {
    let m = e.to_string();
    m.contains("Cannot modify") || m.contains("SETTING_CONSTRAINT_VIOLATION") || m.contains("READONLY")
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
                server_limit: std::sync::atomic::AtomicBool::new(true),
                cache_off: std::sync::atomic::AtomicBool::new(true),
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

    /// `no_cache` = tắt query cache cho request này (nếu user được phép đổi setting).
    fn request(&self, sql: &str, params: &[(&str, String)], no_cache: bool) -> reqwest::RequestBuilder {
        let mut q: Vec<(&str, String)> = vec![
            ("default_format", "JSONCompactEachRowWithNamesAndTypes".into()),
            ("output_format_json_quote_64bit_integers", "0".into()),
        ];
        if self.read_only {
            q.push(("readonly", "2".into()));
        }
        if no_cache && self.cache_off.load(std::sync::atomic::Ordering::Relaxed) {
            q.push(("use_query_cache", "0".into()));
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

    /// Câu lệnh nhỏ (metadata, Monitor…): tắt query cache, đọc toàn bộ thành các dòng.
    async fn rows(&self, sql: &str, params: &[(&str, String)]) -> anyhow::Result<Vec<Vec<Option<String>>>> {
        use std::sync::atomic::Ordering;
        let resp = match self.send(self.request(sql, params, true)).await {
            // User không được đổi setting (readonly=1 / constraint) → thôi gửi use_query_cache.
            Err(e) if self.cache_off.load(Ordering::Relaxed) && is_setting_denied(&e) => {
                self.cache_off.store(false, Ordering::Relaxed);
                self.send(self.request(sql, params, false)).await?
            }
            r => r?,
        };
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
        use std::sync::atomic::Ordering;
        for stmt in split_statements(sql) {
            let mut res = self.run_tracked(&stmt, db.clone(), limit, false).await;
            if self.server_limit.load(Ordering::Relaxed)
                && matches!(&res, Err(e) if e.to_string().contains("QUERY_CACHE_USED_WITH_NON_THROW_OVERFLOW_MODE"))
            {
                // Profile của user bật use_query_cache → không đặt giới hạn phía server nữa.
                self.server_limit.store(false, Ordering::Relaxed);
                res = self.run_tracked(&stmt, db.clone(), limit, false).await;
            }
            if matches!(&res, Err(e) if e.to_string().contains("QUERY_CACHE_USED_WITH_NONDETERMINISTIC_FUNCTIONS")) {
                // Câu có now()/rand()… mà profile bật cache → chạy lại không dùng cache.
                res = self.run_tracked(&stmt, db.clone(), limit, true).await;
            }
            sets.push(res?);
        }
        Ok((sets, db))
    }

    async fn run_tracked(&self, stmt: &str, db: Option<String>, limit: usize, no_cache: bool) -> anyhow::Result<ResultSet> {
        let query_id = uuid::Uuid::new_v4().to_string();
        *self.running.lock().unwrap() = Some(query_id.clone());
        let res = self.run_one(stmt, db, limit, &query_id, no_cache).await;
        *self.running.lock().unwrap() = None;
        res
    }

    async fn run_one(
        &self,
        stmt: &str,
        db: Option<String>,
        limit: usize,
        query_id: &str,
        no_cache: bool,
    ) -> anyhow::Result<ResultSet> {
        let mut params = vec![
            ("session_id", self.session_id.clone()),
            ("session_timeout", "3600".to_string()),
            ("query_id", query_id.to_string()),
        ];
        if self.server_limit.load(std::sync::atomic::Ordering::Relaxed) {
            params.push(("max_result_rows", (limit + 1).to_string()));
            params.push(("result_overflow_mode", "break".to_string()));
        }
        if let Some(db) = db {
            params.push(("database", db));
        }
        let resp = self.send(self.request(stmt, &params, no_cache)).await?;
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
            self.rows(&format!("KILL QUERY WHERE query_id = '{id}' ASYNC"), &[]).await?;
        }
        Ok(())
    }

    /// Monitor: system.events (bộ đếm), system.metrics + asynchronous_metrics (tức
    /// thời), system.processes (query đang chạy).
    pub async fn monitor(&self, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        let mut snap = MonitorSnapshot::default();
        let sql = "SELECT 'ev_' || event, toFloat64(value) FROM system.events WHERE event IN \
                     ('Query','SelectQuery','InsertQuery','FailedQuery','SelectedRows','SelectedBytes','InsertedRows','InsertedBytes') \
                   UNION ALL SELECT 'm_' || metric, toFloat64(value) FROM system.metrics WHERE metric IN \
                     ('Query','Merge','TCPConnection','HTTPConnection','MemoryTracking') \
                   UNION ALL SELECT 'a_' || metric, toFloat64(value) FROM system.asynchronous_metrics WHERE metric IN \
                     ('Uptime','TotalPartsOfMergeTreeTables','MaxPartCountForPartition','OSMemoryTotal')";
        for r in self.rows(sql, &[]).await? {
            if let (Some(Some(k)), Some(Some(v))) = (r.first(), r.get(1)) {
                if let Some(n) = num(v) {
                    snap.values.insert(k.clone(), n);
                }
            }
        }
        let procs = self
            .rows(
                "SELECT query_id, user, toString(round(elapsed, 1)), formatReadableSize(memory_usage), \
                   toString(read_rows), substring(query, 1, 500) \
                 FROM system.processes WHERE query NOT ILIKE '%system.processes%' \
                 ORDER BY elapsed DESC LIMIT 200",
                &[],
            )
            .await?;
        snap.tables.push(MonitorTable {
            title: "Running queries".into(),
            columns: ["query id", "user", "elapsed (s)", "memory", "rows read", "query"].map(String::from).to_vec(),
            rows: procs
                .into_iter()
                .map(|cells| MonitorRow { id: cells.first().cloned().flatten(), cells })
                .collect(),
            killable: true,
        });
        if breakdown {
            let sizes = self
                .rows(
                    "SELECT database, toFloat64(sum(bytes_on_disk)) FROM system.parts WHERE active \
                     GROUP BY database ORDER BY 2 DESC LIMIT 20",
                    &[],
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

    /// Bảng của một database theo system.parts (part còn hiệu lực): số dòng chính xác,
    /// dung lượng nén trên đĩa và chưa nén, engine.
    pub async fn table_sizes(&self, database: &str) -> anyhow::Result<TableSizes> {
        let rows = self
            .rows(
                "SELECT p.table, any(t.engine), toFloat64(sum(p.rows)), toFloat64(sum(p.bytes_on_disk)), \
                   toFloat64(sum(p.data_uncompressed_bytes)) \
                 FROM system.parts AS p LEFT JOIN system.tables AS t ON t.database = p.database AND t.name = p.table \
                 WHERE p.active AND p.database = {db:String} \
                 GROUP BY p.table ORDER BY sum(p.bytes_on_disk) DESC",
                &[("param_db", database.to_string())],
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
                    data_bytes: None,
                    index_bytes: None,
                    uncompressed_bytes: n(r, 4),
                })
                .collect(),
            rows_exact: true,
        })
    }

    /// KILL QUERY theo query_id (truyền dạng tham số, không ghép chuỗi).
    pub async fn kill(&self, target: &str) -> anyhow::Result<()> {
        self.rows("KILL QUERY WHERE query_id = {id:String} ASYNC", &[("param_id", target.to_string())]).await?;
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
