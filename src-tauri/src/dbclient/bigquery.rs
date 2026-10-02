//! Google BigQuery qua REST API v2 (reqwest + rustls/ring), xác thực bằng gauth.rs.
//!
//! - Mỗi câu lệnh là một query job (GoogleSQL). Script có biến/điều khiển (DECLARE,
//!   BEGIN…) gửi nguyên khối; còn lại tách theo `;` để mỗi câu có bảng kết quả riêng.
//! - `SELECT * FROM <bảng> LIMIT n` (xem nhanh bảng) đọc bằng tabledata.list — miễn
//!   phí, không quét cả bảng như query.
//! - Read-only: ngoài bộ lọc chung, dry-run để BigQuery xác nhận câu lệnh là SELECT.
//! - "Max bytes billed" (tuỳ chọn) chặn query quét quá nhiều dữ liệu.

use super::gauth::GoogleAuth;
use super::{split_statements, sql_words, ConnectSpec, Column, MonitorRow, MonitorSnapshot, MonitorTable, ResultSet, TableSizes, TableStat, TreeNode};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, Notify};

const API: &str = "https://bigquery.googleapis.com/bigquery/v2";
/// Mỗi lần chờ job tối đa (ms) trước khi hỏi lại.
const WAIT_MS: u64 = 10_000;
/// Dung lượng theo dataset (INFORMATION_SCHEMA — tính phí tối thiểu 10 MB) chỉ đo lại sau chừng này.
const BREAKDOWN_TTL: Duration = Duration::from_secs(600);

pub struct BqSession {
    http: reqwest::Client,
    auth: GoogleAuth,
    base: String,
    project: String,
    location: Option<String>,
    default_dataset: Option<String>,
    max_bytes_billed: Option<i64>,
    read_only: bool,
    cancel: Notify,
    /// Job đang chạy của editor (để huỷ): (job id, location).
    running: std::sync::Mutex<Option<(String, Option<String>)>>,
    breakdown: Mutex<Option<(Instant, Vec<(String, f64)>)>>,
}

fn opt(spec: &ConnectSpec, key: &str) -> Option<String> {
    let v: Value = serde_json::from_str(spec.options.as_deref()?).ok()?;
    match v.get(key)? {
        Value::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Mã hoá một đoạn đường dẫn URL (id dataset/bảng có thể chứa ký tự đặc biệt).
fn seg(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn s(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn n(v: &Value, key: &str) -> Option<f64> {
    s(v, key)?.parse().ok()
}

/// Micro giây từ epoch → "YYYY-MM-DD HH:MM:SS[.ffffff] UTC".
fn fmt_timestamp(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let frac = micros.rem_euclid(1_000_000);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Ngày dân dụng từ số ngày (thuật toán của Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let base = format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", tod / 3600, tod % 3600 / 60, tod % 60);
    if frac == 0 {
        format!("{base} UTC")
    } else {
        format!("{base}.{}", format!("{frac:06}").trim_end_matches('0')) + " UTC"
    }
}

/// Giá trị một ô theo schema → JSON (để lồng RECORD/REPEATED).
fn cell_json(field: &Value, v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    if field.get("mode").and_then(Value::as_str) == Some("REPEATED") {
        let mut f = field.clone();
        f["mode"] = json!("NULLABLE");
        return Value::Array(
            v.as_array().map(|a| a.iter().map(|x| cell_json(&f, x.get("v").unwrap_or(&Value::Null))).collect()).unwrap_or_default(),
        );
    }
    let ty = field.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "RECORD" | "STRUCT" => {
            let subs = field.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
            let vals = v.get("f").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut obj = serde_json::Map::new();
            for (sf, sv) in subs.iter().zip(vals.iter()) {
                let name = sf.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                obj.insert(name, cell_json(sf, sv.get("v").unwrap_or(&Value::Null)));
            }
            Value::Object(obj)
        }
        "TIMESTAMP" => match v.as_str().and_then(|t| t.parse::<i64>().ok()) {
            Some(us) => json!(fmt_timestamp(us)),
            None => v.clone(),
        },
        "INTEGER" | "INT64" => v.as_str().and_then(|t| t.parse::<i64>().ok()).map(|i| json!(i)).unwrap_or_else(|| v.clone()),
        "FLOAT" | "FLOAT64" => v.as_str().and_then(|t| t.parse::<f64>().ok()).map(|f| json!(f)).unwrap_or_else(|| v.clone()),
        "BOOLEAN" | "BOOL" => match v.as_str() {
            Some("true") => json!(true),
            Some("false") => json!(false),
            _ => v.clone(),
        },
        "JSON" => v.as_str().and_then(|t| serde_json::from_str(t).ok()).unwrap_or_else(|| v.clone()),
        _ => v.clone(),
    }
}

/// Ô → chuỗi hiển thị (lồng → JSON gọn).
fn cell(field: &Value, v: &Value) -> Option<String> {
    match cell_json(field, v) {
        Value::Null => None,
        Value::String(s) => Some(s),
        other => Some(other.to_string()),
    }
}

fn columns(schema: &Value) -> (Vec<Value>, Vec<Column>) {
    let fields = schema.get("fields").and_then(Value::as_array).cloned().unwrap_or_default();
    let cols = fields
        .iter()
        .map(|f| {
            let ty = f.get("type").and_then(Value::as_str).unwrap_or("");
            let repeated = f.get("mode").and_then(Value::as_str) == Some("REPEATED");
            Column {
                name: f.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                type_name: Some(if repeated { format!("ARRAY<{ty}>") } else { ty.to_string() }),
            }
        })
        .collect();
    (fields, cols)
}

fn push_rows(set: &mut ResultSet, fields: &[Value], rows: &Value, limit: usize) {
    for r in rows.as_array().map(Vec::as_slice).unwrap_or_default() {
        if set.rows.len() >= limit {
            set.truncated = true;
            return;
        }
        let vals = r.get("f").and_then(Value::as_array).cloned().unwrap_or_default();
        set.rows.push(
            fields
                .iter()
                .enumerate()
                .map(|(i, f)| vals.get(i).and_then(|c| cell(f, c.get("v").unwrap_or(&Value::Null))))
                .collect(),
        );
    }
}

/// Câu lệnh cần chạy nguyên khối như một script BigQuery (biến, khối lệnh…).
fn is_script(sql: &str) -> bool {
    split_statements(sql).iter().any(|st| {
        let w = sql_words(st);
        let first = w.first().map(String::as_str).unwrap_or("");
        matches!(
            first,
            "DECLARE" | "SET" | "BEGIN" | "IF" | "LOOP" | "WHILE" | "REPEAT" | "FOR" | "CALL" | "EXECUTE" | "RAISE"
                | "RETURN" | "BREAK" | "LEAVE" | "CONTINUE" | "ITERATE" | "EXCEPTION" | "END"
        ) || (first == "CREATE" && w.get(1).is_some_and(|x| x == "TEMP" || x == "TEMPORARY"))
    })
}

/// `SELECT * FROM <bảng> LIMIT n` → (dataset?, bảng, n) để đọc bằng tabledata.list.
fn preview_target(sql: &str) -> Option<(Option<String>, String, usize)> {
    let t = sql.trim().trim_end_matches(';').trim();
    let lower = t.to_ascii_lowercase();
    let rest = lower.strip_prefix("select")?.trim_start().strip_prefix('*')?.trim_start().strip_prefix("from")?;
    let rest_orig = &t[t.len() - rest.len()..];
    let rest_orig = rest_orig.trim_start();
    let (table_ref, after) = match rest_orig.find(|c: char| c.is_whitespace()) {
        Some(i) => rest_orig.split_at(i),
        None => return None,
    };
    let after = after.trim().to_ascii_lowercase();
    let limit: usize = after.strip_prefix("limit")?.trim().parse().ok()?;
    // Tên bảng: `a`.`b` · a.b · `a.b` · `p.a.b` (bỏ project nếu là project hiện tại — kiểm ở chỗ gọi).
    let joined: String = table_ref.chars().filter(|c| *c != '`').collect();
    if joined.is_empty() || !joined.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '$')) {
        return None;
    }
    let parts: Vec<&str> = joined.split('.').collect();
    match parts.as_slice() {
        [t] => Some((None, t.to_string(), limit)),
        [d, t] => Some((Some(d.to_string()), t.to_string(), limit)),
        [p, d, t] => Some((Some(format!("{p}:{d}")), t.to_string(), limit)),
        _ => None,
    }
}

impl BqSession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        if spec.host != spec.tls_host {
            anyhow::bail!("BigQuery is an HTTPS API — an SSH tunnel isn't supported for it.");
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .user_agent("Termez")
            .build()?;
        #[cfg(test)]
        let test_token = opt(spec, "testToken");
        #[cfg(not(test))]
        let test_token: Option<String> = None;
        let auth = match (test_token, opt(spec, "auth").as_deref()) {
            #[cfg(test)]
            (Some(t), _) => GoogleAuth::fixed(&t, http.clone()),
            (_, Some("key")) => {
                if spec.password.trim().is_empty() {
                    anyhow::bail!("Paste the service account key (JSON) for this connection.");
                }
                GoogleAuth::from_json(&spec.password, http.clone())?
            }
            _ => GoogleAuth::adc(http.clone())?,
        };
        let project = opt(spec, "project")
            .or_else(|| auth.project_hint.clone())
            .ok_or_else(|| anyhow::anyhow!("Project ID is required."))?;
        #[cfg(test)]
        let base = opt(spec, "endpoint").unwrap_or_else(|| API.to_string());
        #[cfg(not(test))]
        let base = API.to_string();
        let max_bytes_billed = opt(spec, "maxBytesBilledGb")
            .and_then(|g| g.parse::<f64>().ok())
            .filter(|g| *g > 0.0)
            .map(|g| (g * 1e9) as i64);
        let s = Self {
            http,
            auth,
            base,
            project,
            location: opt(spec, "location"),
            default_dataset: spec.database.clone().filter(|d| !d.trim().is_empty()),
            max_bytes_billed,
            read_only: spec.read_only,
            cancel: Notify::new(),
            running: std::sync::Mutex::new(None),
            breakdown: Mutex::new(None),
        };
        // Kiểm tra quyền + project bằng một lệnh nhẹ.
        s.call(reqwest::Method::GET, &format!("/projects/{}/datasets", seg(&s.project)), &[("maxResults", "1".into())], None)
            .await?;
        let version = match &s.location {
            Some(l) => format!("{} ({l}) · {}", s.project, s.auth.identity),
            None => format!("{} · {}", s.project, s.auth.identity),
        };
        Ok((s, version))
    }

    pub fn default_database(&self) -> Option<String> {
        self.default_dataset.clone()
    }

    /// Gọi REST API; lỗi của Google → thông báo dễ đọc.
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let token = self.auth.token().await?;
        let mut req = self.http.request(method, format!("{}{path}", self.base)).bearer_auth(token).query(query);
        if let Some(q) = &self.auth.quota_project {
            req = req.header("x-goog-user-project", q);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await?;
        let status = resp.status();
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let err = v.get("error").cloned().unwrap_or(Value::Null);
            let msg = err.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| status.to_string());
            let reason = err
                .get("errors")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|e| e.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if reason == "bytesBilledLimitExceeded" {
                anyhow::bail!("{msg}\n(Raise or clear \"Max bytes billed\" in the connection settings to run it.)");
            }
            anyhow::bail!("{msg}");
        }
        Ok(v)
    }

    fn dataset_ref(&self, dataset: &str) -> Value {
        match dataset.split_once(':').or_else(|| dataset.split_once('.')) {
            Some((p, d)) => json!({ "projectId": p, "datasetId": d }),
            None => json!({ "projectId": self.project, "datasetId": dataset }),
        }
    }

    pub async fn query(
        &self,
        database: Option<String>,
        sql: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        let dataset = database.or_else(|| self.default_dataset.clone());
        let statements = if is_script(sql) { vec![sql.trim().to_string()] } else { split_statements(sql) };
        let mut sets = Vec::new();
        for st in statements {
            if self.read_only {
                self.ensure_select(&st, dataset.as_deref()).await?;
            }
            let res = tokio::select! {
                r = self.run_statement(&st, dataset.as_deref(), limit) => r,
                _ = self.cancel.notified() => Err(anyhow::anyhow!("Cancelled")),
            };
            *self.running.lock().unwrap() = None;
            sets.push(res?);
        }
        Ok((sets, dataset))
    }

    /// Read-only: BigQuery dry-run cho biết loại câu lệnh — chỉ SELECT được chạy.
    async fn ensure_select(&self, sql: &str, dataset: Option<&str>) -> anyhow::Result<()> {
        let mut q = json!({ "query": sql, "useLegacySql": false });
        if let Some(d) = dataset {
            q["defaultDataset"] = self.dataset_ref(d);
        }
        let mut body = json!({ "configuration": { "query": q, "dryRun": true } });
        if let Some(l) = &self.location {
            body["jobReference"] = json!({ "location": l });
        }
        let job = self.call(reqwest::Method::POST, &format!("/projects/{}/jobs", seg(&self.project)), &[], Some(body)).await?;
        let kind = job.pointer("/statistics/query/statementType").and_then(Value::as_str).unwrap_or("");
        if kind != "SELECT" {
            anyhow::bail!(
                "Read-only connection — blocked: this is a {} statement. Only SELECT queries can run. Edit the \
                 connection and untick Read-only to make changes.",
                if kind.is_empty() { "non-SELECT" } else { kind }
            );
        }
        Ok(())
    }

    async fn run_statement(&self, sql: &str, dataset: Option<&str>, limit: usize) -> anyhow::Result<ResultSet> {
        if let Some((d, t, n)) = preview_target(sql) {
            let d = d.or_else(|| dataset.map(str::to_string));
            if let Some(d) = d {
                // Bảng thường → đọc miễn phí; view/bảng ngoài → tabledata.list báo lỗi → chạy query.
                if let Ok(set) = self.preview(&d, &t, n.min(limit), limit).await {
                    return Ok(set);
                }
            }
        }
        self.run_query(sql, dataset, limit).await
    }

    async fn preview(&self, dataset: &str, table: &str, n: usize, limit: usize) -> anyhow::Result<ResultSet> {
        let r = self.dataset_ref(dataset);
        let (p, d) = (r["projectId"].as_str().unwrap_or(""), r["datasetId"].as_str().unwrap_or(""));
        let tpath = format!("/projects/{}/datasets/{}/tables/{}", seg(p), seg(d), seg(table));
        let meta = self.call(reqwest::Method::GET, &tpath, &[], None).await?;
        if meta.get("type").and_then(Value::as_str) != Some("TABLE") {
            anyhow::bail!("not a plain table");
        }
        let (fields, cols) = columns(meta.get("schema").unwrap_or(&Value::Null));
        let mut set = ResultSet { columns: cols, ..Default::default() };
        let mut page: Option<String> = None;
        loop {
            let mut q = vec![
                ("maxResults", (n.saturating_sub(set.rows.len())).clamp(1, 10_000).to_string()),
                ("formatOptions.useInt64Timestamp", "true".into()),
            ];
            if let Some(tk) = &page {
                q.push(("pageToken", tk.clone()));
            }
            let v = self.call(reqwest::Method::GET, &format!("{tpath}/data"), &q, None).await?;
            push_rows(&mut set, &fields, v.get("rows").unwrap_or(&Value::Null), n);
            page = s(&v, "pageToken");
            if set.rows.len() >= n || page.is_none() {
                break;
            }
        }
        let total = n_total(&meta);
        set.truncated = n >= limit && total.is_some_and(|t| t > set.rows.len() as f64);
        Ok(set)
    }

    async fn run_query(&self, sql: &str, dataset: Option<&str>, limit: usize) -> anyhow::Result<ResultSet> {
        let mut body = json!({
            "query": sql,
            "useLegacySql": false,
            "maxResults": (limit + 1).min(10_000),
            "timeoutMs": WAIT_MS,
            "formatOptions": { "useInt64Timestamp": true },
            "requestId": uuid::Uuid::new_v4().to_string(),
            "labels": { "client": "termez" },
        });
        if let Some(d) = dataset {
            body["defaultDataset"] = self.dataset_ref(d);
        }
        if let Some(l) = &self.location {
            body["location"] = json!(l);
        }
        if let Some(b) = self.max_bytes_billed {
            body["maximumBytesBilled"] = json!(b.to_string());
        }
        let mut v = self
            .call(reqwest::Method::POST, &format!("/projects/{}/queries", seg(&self.project)), &[], Some(body))
            .await?;
        let job_id = v.pointer("/jobReference/jobId").and_then(Value::as_str).map(str::to_string);
        let location = v.pointer("/jobReference/location").and_then(Value::as_str).map(str::to_string);
        if let Some(id) = &job_id {
            *self.running.lock().unwrap() = Some((id.clone(), location.clone()));
        }
        let results_path = |id: &str| format!("/projects/{}/queries/{}", seg(&self.project), seg(id));
        let base_q = |extra: Vec<(&'static str, String)>| {
            let mut q = vec![("timeoutMs", WAIT_MS.to_string()), ("formatOptions.useInt64Timestamp", "true".into())];
            if let Some(l) = &location {
                q.push(("location", l.clone()));
            }
            q.extend(extra);
            q
        };
        // Chờ job xong.
        while v.get("jobComplete").and_then(Value::as_bool) == Some(false) {
            let id = job_id.as_deref().ok_or_else(|| anyhow::anyhow!("BigQuery returned no job id"))?;
            v = self
                .call(reqwest::Method::GET, &results_path(id), &base_q(vec![("maxResults", (limit + 1).min(10_000).to_string())]), None)
                .await?;
        }
        if let Some(errs) = v.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
            if v.get("rows").is_none() && v.get("schema").is_none() {
                let msg = errs[0].get("message").and_then(Value::as_str).unwrap_or("query failed");
                anyhow::bail!("{msg}");
            }
        }
        let Some(schema) = v.get("schema").filter(|s| s.get("fields").is_some()) else {
            // DML / DDL: không có bảng kết quả.
            return Ok(ResultSet { affected: Some(n(&v, "numDmlAffectedRows").unwrap_or(0.0) as u64), ..Default::default() });
        };
        let (fields, cols) = columns(schema);
        let mut set = ResultSet { columns: cols, ..Default::default() };
        push_rows(&mut set, &fields, v.get("rows").unwrap_or(&Value::Null), limit);
        let mut page = s(&v, "pageToken");
        while !set.truncated && set.rows.len() < limit + 1 {
            let (Some(tk), Some(id)) = (page.clone(), job_id.as_deref()) else { break };
            let p = self
                .call(
                    reqwest::Method::GET,
                    &results_path(id),
                    &base_q(vec![("pageToken", tk), ("maxResults", (limit + 1 - set.rows.len()).min(10_000).to_string())]),
                    None,
                )
                .await?;
            push_rows(&mut set, &fields, p.get("rows").unwrap_or(&Value::Null), limit);
            page = s(&p, "pageToken");
        }
        if !set.truncated && page.is_some() {
            set.truncated = true;
        }
        if let Some(dml) = n(&v, "numDmlAffectedRows") {
            set.affected = Some(dml as u64);
        }
        Ok(set)
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        self.cancel.notify_waiters();
        let job = self.running.lock().unwrap().take();
        if let Some((id, loc)) = job {
            self.cancel_job(&id, loc).await?;
        }
        Ok(())
    }

    async fn cancel_job(&self, id: &str, location: Option<String>) -> anyhow::Result<()> {
        let q: Vec<(&str, String)> = location.map(|l| vec![("location", l)]).unwrap_or_default();
        self.call(reqwest::Method::POST, &format!("/projects/{}/jobs/{}/cancel", seg(&self.project), seg(id)), &q, None)
            .await?;
        Ok(())
    }

    /// Duyệt mọi trang của một API list.
    async fn list_all(&self, path: &str, key: &str, max: usize) -> anyhow::Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut q = vec![("maxResults", "1000".to_string())];
            if let Some(t) = &page {
                q.push(("pageToken", t.clone()));
            }
            let v = self.call(reqwest::Method::GET, path, &q, None).await?;
            out.extend(v.get(key).and_then(Value::as_array).cloned().unwrap_or_default());
            page = s(&v, "nextPageToken");
            if page.is_none() || out.len() >= max {
                return Ok(out);
            }
        }
    }

    async fn datasets(&self) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let list = self.list_all(&format!("/projects/{}/datasets", seg(&self.project)), "datasets", 10_000).await?;
        let mut out: Vec<(String, Option<String>)> = list
            .iter()
            .filter_map(|d| Some((d.pointer("/datasetReference/datasetId")?.as_str()?.to_string(), s(d, "location"))))
            .collect();
        out.sort();
        Ok(out)
    }

    async fn tables(&self, dataset: &str) -> anyhow::Result<Vec<(String, String)>> {
        let path = format!("/projects/{}/datasets/{}/tables", seg(&self.project), seg(dataset));
        let list = self.list_all(&path, "tables", 10_000).await?;
        let mut out: Vec<(String, String)> = list
            .iter()
            .filter_map(|t| Some((t.pointer("/tableReference/tableId")?.as_str()?.to_string(), s(t, "type").unwrap_or_default())))
            .collect();
        out.sort();
        Ok(out)
    }

    /// Cây: [] → datasets; [dataset] → bảng/view; [dataset, bảng] → cột (RECORD trải phẳng a.b).
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        Ok(match path {
            [] => self
                .datasets()
                .await?
                .into_iter()
                .map(|(name, loc)| TreeNode { name, kind: "database".into(), detail: loc, leaf: false })
                .collect(),
            [d] => self
                .tables(d)
                .await?
                .into_iter()
                .map(|(name, ty)| {
                    let view = matches!(ty.as_str(), "VIEW" | "MATERIALIZED_VIEW");
                    let detail = match ty.as_str() {
                        "TABLE" | "VIEW" => None,
                        other => Some(other.to_lowercase().replace('_', " ")),
                    };
                    TreeNode { name, kind: if view { "view" } else { "table" }.into(), detail, leaf: false }
                })
                .collect(),
            [d, t] => {
                let meta = self
                    .call(
                        reqwest::Method::GET,
                        &format!("/projects/{}/datasets/{}/tables/{}", seg(&self.project), seg(d), seg(t)),
                        &[],
                        None,
                    )
                    .await?;
                let part = meta.pointer("/timePartitioning/field").and_then(Value::as_str).map(str::to_string);
                let cluster: Vec<String> = meta
                    .pointer("/clustering/fields")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let mut out = Vec::new();
                fn walk(fields: &[Value], prefix: &str, part: &Option<String>, cluster: &[String], out: &mut Vec<TreeNode>) {
                    for f in fields {
                        let name = format!("{prefix}{}", f.get("name").and_then(Value::as_str).unwrap_or(""));
                        let mut detail = f.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                        match f.get("mode").and_then(Value::as_str) {
                            Some("REPEATED") => detail = format!("ARRAY<{detail}>"),
                            Some("REQUIRED") => detail.push_str(" NOT NULL"),
                            _ => {}
                        }
                        if part.as_deref() == Some(name.as_str()) {
                            detail.push_str(" · partition");
                        }
                        if cluster.contains(&name) {
                            detail.push_str(" · cluster");
                        }
                        out.push(TreeNode { name: name.clone(), kind: "column".into(), detail: Some(detail), leaf: true });
                        if let Some(sub) = f.get("fields").and_then(Value::as_array) {
                            walk(sub, &format!("{name}."), part, cluster, out);
                        }
                    }
                }
                let fields = meta.pointer("/schema/fields").and_then(Value::as_array).cloned().unwrap_or_default();
                walk(&fields, "", &part, &cluster, &mut out);
                out
            }
            _ => Vec::new(),
        })
    }

    /// Monitor: job đang chạy/đợi (huỷ được) + thống kê job 10 phút gần nhất.
    pub async fn monitor(&self, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        let jobs_path = format!("/projects/{}/jobs", seg(&self.project));
        // allUsers cần quyền bigquery.jobs.listAll — không có thì xem job của chính mình.
        let list = |state: &'static str, projection: &'static str, since: Option<u64>| {
            let jobs_path = jobs_path.clone();
            async move {
                let mut q: Vec<(&str, String)> = vec![
                    ("allUsers", "true".into()),
                    ("projection", projection.into()),
                    ("maxResults", "200".into()),
                    ("stateFilter", state.into()),
                ];
                if let Some(t) = since {
                    q.push(("minCreationTime", t.to_string()));
                }
                let r = match self.call(reqwest::Method::GET, &jobs_path, &q, None).await {
                    Ok(v) => v,
                    Err(e) if e.to_string().contains("ermission") => {
                        q[0].1 = "false".into();
                        self.call(reqwest::Method::GET, &jobs_path, &q, None).await?
                    }
                    Err(e) => return Err(e),
                };
                Ok::<_, anyhow::Error>(r.get("jobs").and_then(Value::as_array).cloned().unwrap_or_default())
            }
        };
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
        let (running, pending, done) = tokio::try_join!(
            list("running", "full", None),
            list("pending", "full", None),
            list("done", "minimal", Some(now_ms - 600_000)),
        )?;

        let mut snap = MonitorSnapshot::default();
        let v = &mut snap.values;
        v.insert("running".into(), running.len() as f64);
        v.insert("pending".into(), pending.len() as f64);
        let (mut bytes, mut billed, mut slot_ms, mut failed) = (0.0, 0.0, 0.0, 0.0);
        for j in &done {
            let st = j.get("statistics").unwrap_or(&Value::Null);
            bytes += n(st, "totalBytesProcessed").or_else(|| st.get("query").and_then(|q| n(q, "totalBytesProcessed"))).unwrap_or(0.0);
            billed += st.get("query").and_then(|q| n(q, "totalBytesBilled")).unwrap_or(0.0);
            slot_ms += n(st, "totalSlotMs").or_else(|| st.get("query").and_then(|q| n(q, "totalSlotMs"))).unwrap_or(0.0);
            if j.pointer("/status/errorResult").is_some() {
                failed += 1.0;
            }
        }
        v.insert("done_10m".into(), done.len() as f64);
        v.insert("failed_10m".into(), failed);
        v.insert("bytes_10m".into(), bytes);
        v.insert("billed_10m".into(), billed);
        v.insert("slot_ms_10m".into(), slot_ms);

        let rows = running
            .iter()
            .chain(pending.iter())
            .filter_map(|j| {
                let id = j.pointer("/jobReference/jobId")?.as_str()?.to_string();
                let loc = j.pointer("/jobReference/location").and_then(Value::as_str).unwrap_or("").to_string();
                let st = j.get("statistics").unwrap_or(&Value::Null);
                let started = n(st, "startTime").or_else(|| n(st, "creationTime"));
                let secs = started.map(|t| ((now_ms as f64 - t) / 1000.0).max(0.0).round().to_string());
                let query = j.pointer("/configuration/query/query").and_then(Value::as_str).map(|q| {
                    let mut q = q.to_string();
                    if q.len() > 2000 {
                        let mut cut = 2000;
                        while !q.is_char_boundary(cut) {
                            cut -= 1;
                        }
                        q.truncate(cut);
                        q.push('…');
                    }
                    q
                });
                let kind = j.pointer("/configuration/jobType").and_then(Value::as_str).unwrap_or("").to_lowercase();
                Some(MonitorRow {
                    id: Some(format!("{loc}|{id}")),
                    cells: vec![
                        Some(id),
                        s(j, "user_email"),
                        j.pointer("/status/state").and_then(Value::as_str).map(str::to_lowercase),
                        Some(kind),
                        Some(loc),
                        secs,
                        query,
                    ],
                })
            })
            .collect();
        snap.tables.push(MonitorTable {
            title: "Running jobs".into(),
            columns: ["job", "user", "state", "type", "location", "time (s)", "query"].map(String::from).to_vec(),
            rows,
            killable: true,
        });
        if breakdown {
            snap.breakdown = self.storage_by_dataset().await;
        }
        Ok(snap)
    }

    /// Dung lượng (logical) theo dataset từ INFORMATION_SCHEMA.TABLE_STORAGE của từng
    /// region có dataset; cache 10 phút vì mỗi lần là một query tính phí tối thiểu.
    async fn storage_by_dataset(&self) -> Option<Vec<(String, f64)>> {
        let mut cache = self.breakdown.lock().await;
        if let Some((at, list)) = cache.as_ref() {
            if at.elapsed() < BREAKDOWN_TTL {
                return Some(list.clone());
            }
        }
        let datasets = self.datasets().await.ok()?;
        let mut regions: Vec<String> = datasets.iter().filter_map(|(_, l)| l.clone()).collect();
        regions.sort();
        regions.dedup();
        let mut out: Vec<(String, f64)> = Vec::new();
        for region in regions.iter().take(5) {
            let sql = format!(
                "SELECT table_schema, SUM(total_logical_bytes) AS bytes FROM `{}`.`region-{}`.INFORMATION_SCHEMA.TABLE_STORAGE \
                 WHERE deleted = FALSE GROUP BY 1",
                self.project,
                region.to_lowercase()
            );
            if let Ok(set) = self.run_query(&sql, None, 10_000).await {
                for r in set.rows {
                    if let (Some(Some(name)), Some(Some(b))) = (r.first(), r.get(1)) {
                        out.push((name.clone(), b.parse().unwrap_or(0.0)));
                    }
                }
            }
        }
        *self.running.lock().unwrap() = None;
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        *cache = Some((Instant::now(), out.clone()));
        Some(out)
    }

    pub async fn kill(&self, target: &str) -> anyhow::Result<()> {
        let (loc, id) = target.split_once('|').unwrap_or(("", target));
        self.cancel_job(id, Some(loc.to_string()).filter(|l| !l.is_empty())).await
    }

    /// Dung lượng + số dòng từng bảng (tables.get — miễn phí, số dòng chính xác).
    pub async fn table_sizes(&self, dataset: &str) -> anyhow::Result<TableSizes> {
        let tables = self.tables(dataset).await?;
        let base = format!("/projects/{}/datasets/{}/tables", seg(&self.project), seg(dataset));
        let metas: Vec<Option<Value>> = futures_util::stream::iter(
            tables.into_iter().filter(|(_, ty)| ty != "VIEW").take(1000).map(|(t, _)| {
                let path = format!("{base}/{}", seg(&t));
                async move { self.call(reqwest::Method::GET, &path, &[], None).await.ok() }
            }),
        )
        .buffer_unordered(16)
        .collect()
        .await;
        let mut stats: Vec<TableStat> = metas
            .into_iter()
            .flatten()
            .map(|m| {
                let total = n(&m, "numBytes").unwrap_or(0.0);
                let long = n(&m, "numLongTermBytes").unwrap_or(0.0);
                TableStat {
                    name: m.pointer("/tableReference/tableId").and_then(Value::as_str).unwrap_or("").to_string(),
                    engine: s(&m, "type").map(|t| t.to_lowercase().replace('_', " ")),
                    rows: n(&m, "numRows"),
                    total_bytes: total,
                    data_bytes: Some(total - long),
                    index_bytes: None,
                    uncompressed_bytes: None,
                }
            })
            .collect();
        stats.sort_by(|a, b| b.total_bytes.total_cmp(&a.total_bytes));
        Ok(TableSizes { tables: stats, rows_exact: true })
    }
}

fn n_total(meta: &Value) -> Option<f64> {
    n(meta, "numRows")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Server BigQuery giả: ghi lại request (method path?query + body) và trả JSON cố định.
    async fn mock_api() -> (String, Arc<StdMutex<Vec<String>>>) {
        let log = Arc::new(StdMutex::new(Vec::<String>::new()));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let log2 = log.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = l.accept().await.unwrap();
                let log = log2.clone();
                tokio::spawn(async move {
                    loop {
                        let mut buf = Vec::new();
                        let mut tmp = [0u8; 8192];
                        let head_end = loop {
                            let n = match sock.read(&mut tmp).await { Ok(0) | Err(_) => return, Ok(n) => n };
                            buf.extend_from_slice(&tmp[..n]);
                            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
                        };
                        let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                        let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
                        while buf.len() < head_end + len {
                            let n = match sock.read(&mut tmp).await { Ok(0) | Err(_) => return, Ok(n) => n };
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        let body: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
                        let line = head.lines().next().unwrap_or("").to_string();
                        let mut it = line.split(' ');
                        let (method, target) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
                        let (path, query) = target.split_once('?').unwrap_or((target, ""));
                        log.lock().unwrap().push(format!("{method} {path}?{query} {body}"));
                        let authed = head.to_ascii_lowercase().contains("authorization: bearer test-token");
                        let q = body.get("query").or_else(|| body.pointer("/configuration/query/query")).and_then(Value::as_str).unwrap_or("").to_string();
                        let (status, resp) = if !authed {
                            (401, json!({ "error": { "message": "no token" } }))
                        } else {
                            match (method, path) {
                                ("GET", "/projects/p/datasets") => (200, json!({ "datasets": [{ "datasetReference": { "datasetId": "shop" }, "location": "US" }] })),
                                ("GET", "/projects/p/datasets/shop/tables") => (200, json!({ "tables": [
                                    { "tableReference": { "tableId": "orders" }, "type": "TABLE" },
                                    { "tableReference": { "tableId": "v_orders" }, "type": "VIEW" } ] })),
                                ("GET", "/projects/p/datasets/shop/tables/orders") => (200, json!({
                                    "tableReference": { "tableId": "orders" }, "type": "TABLE", "numRows": "3", "numBytes": "1000", "numLongTermBytes": "400",
                                    "timePartitioning": { "field": "at" }, "clustering": { "fields": ["name"] },
                                    "schema": { "fields": [
                                        { "name": "id", "type": "INTEGER", "mode": "REQUIRED" },
                                        { "name": "name", "type": "STRING" },
                                        { "name": "at", "type": "TIMESTAMP" },
                                        { "name": "addr", "type": "RECORD", "fields": [{ "name": "city", "type": "STRING" }] } ] } })),
                                ("GET", "/projects/p/datasets/shop/tables/orders/data") => {
                                    let row = |i: i64| json!({ "f": [{ "v": i.to_string() }, { "v": format!("n{i}") }, { "v": "0" }, { "v": { "f": [{ "v": "Hanoi" }] } }] });
                                    if query.contains("pageToken=t2") { (200, json!({ "rows": [row(3)] })) }
                                    else { (200, json!({ "rows": [row(1), row(2)], "pageToken": "t2" })) }
                                }
                                ("POST", "/projects/p/jobs") => {
                                    let ty = if q.trim_start().to_ascii_uppercase().starts_with("SELECT") { "SELECT" } else { "DELETE" };
                                    (200, json!({ "statistics": { "query": { "statementType": ty } } }))
                                }
                                ("POST", "/projects/p/queries") if q.contains("slow") => (200, json!({ "jobComplete": false, "jobReference": { "jobId": "slow1", "location": "US" } })),
                                ("GET", "/projects/p/queries/slow1") => {
                                    tokio::time::sleep(Duration::from_millis(300)).await;
                                    (200, json!({ "jobComplete": false, "jobReference": { "jobId": "slow1", "location": "US" } }))
                                }
                                ("POST", "/projects/p/jobs/slow1/cancel") => (200, json!({})),
                                ("POST", "/projects/p/queries") if q.starts_with("DELETE") => (200, json!({ "jobComplete": true, "numDmlAffectedRows": "4", "jobReference": { "jobId": "d1" } })),
                                ("POST", "/projects/p/queries") if q.contains("bad") => (400, json!({ "error": { "message": "Syntax error: bad", "errors": [{ "reason": "invalidQuery" }] } })),
                                ("POST", "/projects/p/queries") => (200, json!({ "jobComplete": true, "jobReference": { "jobId": "q1", "location": "US" },
                                    "schema": { "fields": [{ "name": "x", "type": "INTEGER" }, { "name": "tags", "type": "STRING", "mode": "REPEATED" }] },
                                    "rows": [{ "f": [{ "v": "1" }, { "v": [{ "v": "a" }] }] }, { "f": [{ "v": "2" }, { "v": [] }] }], "pageToken": "q2" })),
                                ("GET", "/projects/p/queries/q1") => (200, json!({ "jobComplete": true, "rows": [{ "f": [{ "v": "3" }, { "v": null }] }] })),
                                ("GET", "/projects/p/jobs") if query.contains("stateFilter=running") => (200, json!({ "jobs": [{
                                    "jobReference": { "jobId": "r1", "location": "US" }, "user_email": "a@b.c", "status": { "state": "RUNNING" },
                                    "configuration": { "jobType": "QUERY", "query": { "query": "SELECT termez_mon" } }, "statistics": { "startTime": "1" } }] })),
                                ("GET", "/projects/p/jobs") if query.contains("stateFilter=done") => (200, json!({ "jobs": [
                                    { "statistics": { "totalBytesProcessed": "100", "totalSlotMs": "5", "query": { "totalBytesBilled": "10485760" } }, "status": {} },
                                    { "statistics": {}, "status": { "errorResult": { "message": "x" } } } ] })),
                                ("GET", "/projects/p/jobs") => (200, json!({})),
                                _ => (404, json!({ "error": { "message": format!("mock: no route {method} {path}") } })),
                            }
                        };
                        let text = resp.to_string();
                        let out = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
                        if sock.write_all(out.as_bytes()).await.is_err() { return; }
                    }
                });
            }
        });
        (format!("http://{addr}"), log)
    }

    fn mock_spec(endpoint: &str, read_only: bool) -> ConnectSpec {
        ConnectSpec {
            kind: "bigquery".into(),
            host: "bigquery.googleapis.com".into(),
            port: 443,
            tls_host: "bigquery.googleapis.com".into(),
            username: String::new(),
            password: String::new(),
            database: Some("shop".into()),
            ssl_mode: "require".into(),
            read_only,
            options: Some(json!({ "project": "p", "testToken": "test-token", "endpoint": endpoint, "maxBytesBilledGb": "2" }).to_string()),
        }
    }

    #[tokio::test]
    async fn against_mock_api() {
        let (endpoint, log) = mock_api().await;
        let m = std::sync::Arc::new(super::super::DbManager::new());
        let info = m.open(mock_spec(&endpoint, false), None).await.expect("open");
        assert_eq!(info.database.as_deref(), Some("shop"));
        let id = info.session_id;

        // Cây.
        let ds = m.tree(&id, &[]).await.unwrap();
        assert_eq!((ds[0].name.as_str(), ds[0].detail.as_deref()), ("shop", Some("US")));
        let tables = m.tree(&id, &["shop".into()]).await.unwrap();
        assert_eq!(tables.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect::<Vec<_>>(), [("orders", "table"), ("v_orders", "view")]);
        let cols = m.tree(&id, &["shop".into(), "orders".into()]).await.unwrap();
        let d: Vec<_> = cols.iter().map(|c| format!("{} {}", c.name, c.detail.as_deref().unwrap_or(""))).collect();
        assert_eq!(d, ["id INTEGER NOT NULL", "name STRING · cluster", "at TIMESTAMP · partition", "addr RECORD", "addr.city STRING"]);

        // Xem nhanh bảng = tabledata.list (không tạo query job), có phân trang.
        log.lock().unwrap().clear();
        let out = m.query(&id, None, "SELECT * FROM `shop`.`orders` LIMIT 100;", 1000).await.expect("preview");
        let rs = &out.results[0];
        assert_eq!(rs.rows.len(), 3);
        assert_eq!(rs.rows[0], vec![Some("1".into()), Some("n1".into()), Some("1970-01-01 00:00:00 UTC".into()), Some(r#"{"city":"Hanoi"}"#.into())]);
        assert!(!log.lock().unwrap().iter().any(|r| r.contains("/queries")), "preview không được chạy query");

        // Query: 2 câu, phân trang, giới hạn dòng, maximumBytesBilled.
        log.lock().unwrap().clear();
        let out = m.query(&id, None, "SELECT x, tags FROM t; DELETE FROM t WHERE true", 1000).await.expect("query");
        assert_eq!(out.results[0].rows, vec![
            vec![Some("1".into()), Some(r#"["a"]"#.into())],
            vec![Some("2".into()), Some("[]".into())],
            vec![Some("3".into()), None],
        ]);
        assert_eq!(out.results[0].columns[1].type_name.as_deref(), Some("ARRAY<STRING>"));
        assert_eq!(out.results[1].affected, Some(4));
        let reqs = log.lock().unwrap().clone();
        assert!(reqs.iter().any(|r| r.contains("\"maximumBytesBilled\":\"2000000000\"")), "{reqs:?}");
        assert!(reqs.iter().any(|r| r.contains("\"defaultDataset\":{\"projectId\":\"p\",\"datasetId\":\"shop\"}")), "{reqs:?}");
        let out = m.query(&id, None, "SELECT x FROM t", 1).await.unwrap();
        assert_eq!(out.results[0].rows.len(), 1);
        assert!(out.results[0].truncated);
        let err = m.query(&id, None, "SELECT bad", 10).await.err().unwrap();
        assert!(err.to_string().contains("Syntax error: bad"));

        // Huỷ job dài → gọi jobs.cancel.
        let (m2, id2) = (m.clone(), id.clone());
        let t = tokio::spawn(async move { m2.query(&id2, None, "SELECT slow", 10).await });
        tokio::time::sleep(Duration::from_millis(500)).await;
        m.cancel(&id).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), t).await.is_ok());
        assert!(log.lock().unwrap().iter().any(|r| r.starts_with("POST /projects/p/jobs/slow1/cancel?location=US")));

        // Read-only: dry-run chặn câu không phải SELECT (kể cả khi qua được bộ lọc chung).
        let ro = m.open(mock_spec(&endpoint, true), None).await.unwrap().session_id;
        let r = m.query(&ro, None, "SELECT x FROM t", 10).await;
        assert!(r.is_ok(), "{:?}", r.err());
        let err = m.query(&ro, None, "DELETE FROM t WHERE true", 10).await.err().unwrap();
        assert!(err.to_string().contains("Read-only"), "{err}");

        // Monitor + kích thước bảng.
        let snap = m.monitor(&id, false).await.unwrap();
        assert_eq!(snap.values["running"], 1.0);
        assert_eq!(snap.values["done_10m"], 2.0);
        assert_eq!(snap.values["failed_10m"], 1.0);
        assert_eq!(snap.values["billed_10m"], 10485760.0);
        let row = &snap.tables[0].rows[0];
        assert_eq!(row.id.as_deref(), Some("US|r1"));
        assert!(row.cells.iter().flatten().any(|c| c.contains("termez_mon")));
        let sizes = m.table_sizes(&id, "shop").await.unwrap();
        assert_eq!(sizes.tables.len(), 1);
        assert_eq!((sizes.tables[0].rows, sizes.tables[0].total_bytes, sizes.tables[0].data_bytes), (Some(3.0), 1000.0, Some(600.0)));
    }

    #[test]
    fn formats_timestamps() {
        assert_eq!(fmt_timestamp(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(fmt_timestamp(1_790_917_200_123_450), "2026-10-02 05:00:00.12345 UTC");
        assert_eq!(fmt_timestamp(-1_000_000), "1969-12-31 23:59:59 UTC");
    }

    #[test]
    fn detects_preview_and_scripts() {
        assert_eq!(preview_target("SELECT * FROM `shop`.`orders` LIMIT 100;"), Some((Some("shop".into()), "orders".into(), 100)));
        assert_eq!(preview_target("select * from `p.shop.orders` limit 5"), Some((Some("p:shop".into()), "orders".into(), 5)));
        assert_eq!(preview_target("SELECT * FROM orders WHERE x LIMIT 5"), None);
        assert_eq!(preview_target("SELECT a FROM orders LIMIT 5"), None);
        assert!(is_script("DECLARE x INT64 DEFAULT 1; SELECT x"));
        assert!(!is_script("SELECT 1; SELECT 2"));
    }

    #[test]
    fn renders_nested_cells() {
        let field = json!({ "name": "r", "type": "RECORD", "mode": "REPEATED", "fields": [
            { "name": "a", "type": "INTEGER" }, { "name": "t", "type": "TIMESTAMP" } ] });
        let v = json!([{ "v": { "f": [{ "v": "7" }, { "v": "0" }] } }]);
        assert_eq!(cell(&field, &v).unwrap(), r#"[{"a":7,"t":"1970-01-01 00:00:00 UTC"}]"#);
    }
}
