//! Redis qua crate `redis` (multiplexed, TLS rustls + ring).
//!
//! "Editor" của Redis là một console: mỗi dòng một lệnh (`GET key`, `HGETALL h`…),
//! tách đối số như shell (hỗ trợ "…" và '…'). Mỗi kết quả thành một bảng.
//! Read-only: chặn mọi lệnh mà server đánh dấu `write` (theo `COMMAND INFO`).

use super::{Column, ConnectSpec, ResultSet, TreeNode};
use redis::aio::MultiplexedConnection;
use redis::Value;
use std::collections::HashMap;
use tokio::sync::{Mutex, Notify};

/// Số key tối đa liệt kê trong cây (SCAN dừng khi đủ).
const TREE_KEYS: usize = 500;

pub struct RedisSession {
    /// URL không kèm số database (thêm `/<db>` khi mở kết nối cho từng db).
    url: String,
    default_db: i64,
    read_only: bool,
    conns: Mutex<HashMap<i64, MultiplexedConnection>>,
    /// Lệnh nào là lệnh ghi (cache từ COMMAND INFO).
    writes: Mutex<HashMap<String, bool>>,
    cancel: Notify,
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// "db3" | "3" → 3
fn parse_db(s: &str) -> Option<i64> {
    s.trim().trim_start_matches("db").parse().ok()
}

impl RedisSession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        // Crate redis dựng TLS bằng provider mặc định của rustls → cài `ring`.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = spec.ssl_mode == "require" || spec.ssl_mode == "verify";
        let auth = match (spec.username.is_empty(), spec.password.is_empty()) {
            (true, true) => String::new(),
            (true, false) => format!(":{}@", enc(&spec.password)),
            (false, _) => format!("{}:{}@", enc(&spec.username), enc(&spec.password)),
        };
        let host = if spec.host.contains(':') { format!("[{}]", spec.host) } else { spec.host.clone() };
        let mut url = format!("{}://{auth}{host}:{}", if tls { "rediss" } else { "redis" }, spec.port);
        // Qua tunnel driver nối 127.0.0.1 nên không thể kiểm tên chứng chỉ (kênh
        // vốn đã được SSH mã hoá); "require" cũng không kiểm chứng chỉ.
        if tls && (spec.ssl_mode != "verify" || spec.host != spec.tls_host) {
            url.push_str("#insecure");
        }
        let default_db = spec.database.as_deref().and_then(parse_db).unwrap_or(0);
        let s = Self {
            url,
            default_db,
            read_only: spec.read_only,
            conns: Mutex::new(HashMap::new()),
            writes: Mutex::new(HashMap::new()),
            cancel: Notify::new(),
        };
        let mut c = s.conn(default_db).await?;
        let info: String = redis::cmd("INFO").arg("server").query_async(&mut c).await?;
        let version = info
            .lines()
            .find_map(|l| l.strip_prefix("redis_version:"))
            .unwrap_or("")
            .trim()
            .to_string();
        Ok((s, version))
    }

    pub fn default_database(&self) -> String {
        format!("db{}", self.default_db)
    }

    async fn conn(&self, db: i64) -> anyhow::Result<MultiplexedConnection> {
        let mut map = self.conns.lock().await;
        if let Some(c) = map.get(&db) {
            return Ok(c.clone());
        }
        let url = match self.url.split_once('#') {
            Some((u, frag)) => format!("{u}/{db}#{frag}"),
            None => format!("{}/{db}", self.url),
        };
        let c = redis::Client::open(url)?.get_multiplexed_async_connection().await?;
        map.insert(db, c.clone());
        Ok(c)
    }

    async fn is_write(&self, c: &mut MultiplexedConnection, name: &str) -> anyhow::Result<bool> {
        let key = name.to_ascii_lowercase();
        if let Some(w) = self.writes.lock().await.get(&key) {
            return Ok(*w);
        }
        let info: Value = redis::cmd("COMMAND").arg("INFO").arg(&key).query_async(c).await?;
        // [[name, arity, [flags…], …]] — lệnh lạ (nil) coi như ghi cho an toàn.
        let w = match info {
            Value::Array(items) => match items.first() {
                Some(Value::Array(e)) => match e.get(2) {
                    Some(Value::Array(flags)) | Some(Value::Set(flags)) => flags.iter().any(|f| text(f) == "write"),
                    _ => true,
                },
                _ => true,
            },
            _ => true,
        };
        self.writes.lock().await.insert(key, w);
        Ok(w)
    }

    pub async fn query(
        &self,
        database: Option<String>,
        script: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        let db = database.as_deref().and_then(parse_db).unwrap_or(self.default_db);
        let mut c = self.conn(db).await?;
        let mut sets = Vec::new();
        for line in script.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                continue;
            }
            let args = tokenize(line)?;
            let Some(name) = args.first() else { continue };
            if name.eq_ignore_ascii_case("select") {
                anyhow::bail!("Use the database picker in the toolbar to switch databases (SELECT is per connection).");
            }
            if self.read_only && self.is_write(&mut c, name).await? {
                anyhow::bail!("Read-only connection: `{}` is a write command.", name.to_ascii_uppercase());
            }
            let mut cmd = redis::cmd(name);
            for a in &args[1..] {
                cmd.arg(a);
            }
            let v: Value = tokio::select! {
                r = cmd.query_async(&mut c) => r?,
                _ = self.cancel.notified() => {
                    // Lệnh chặn (BLPOP…) vẫn giữ kết nối → bỏ kết nối này, lần sau mở mới.
                    self.conns.lock().await.remove(&db);
                    anyhow::bail!("Cancelled");
                }
            };
            sets.push(to_result(name, v, limit));
        }
        Ok((sets, Some(format!("db{db}"))))
    }

    pub async fn cancel(&self) -> anyhow::Result<()> {
        self.cancel.notify_waiters();
        Ok(())
    }

    /// Cây: [] → các database (INFO keyspace); [dbN] → key (SCAN, tối đa 500).
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        match path {
            [] => {
                let mut c = self.conn(self.default_db).await?;
                let info: String = redis::cmd("INFO").arg("keyspace").query_async(&mut c).await?;
                let mut dbs: Vec<(i64, String)> = info
                    .lines()
                    .filter_map(|l| {
                        let (name, rest) = l.split_once(':')?;
                        let n = parse_db(name)?;
                        let keys = rest.split(',').find_map(|kv| kv.strip_prefix("keys="))?.to_string();
                        Some((n, format!("{keys} keys")))
                    })
                    .collect();
                if !dbs.iter().any(|(n, _)| *n == self.default_db) {
                    dbs.push((self.default_db, "empty".into()));
                }
                dbs.sort();
                Ok(dbs
                    .into_iter()
                    .map(|(n, detail)| TreeNode { name: format!("db{n}"), kind: "database".into(), detail: Some(detail), leaf: false })
                    .collect())
            }
            [db] => {
                let n = parse_db(db).unwrap_or(0);
                let mut c = self.conn(n).await?;
                let mut keys: Vec<String> = Vec::new();
                let mut cursor = 0u64;
                loop {
                    let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
                        .arg(cursor)
                        .arg("COUNT")
                        .arg(1000)
                        .query_async(&mut c)
                        .await?;
                    keys.extend(batch);
                    cursor = next;
                    if cursor == 0 || keys.len() >= TREE_KEYS {
                        break;
                    }
                }
                let more = cursor != 0 || keys.len() > TREE_KEYS;
                keys.truncate(TREE_KEYS);
                keys.sort();
                let mut pipe = redis::pipe();
                for k in &keys {
                    pipe.cmd("TYPE").arg(k);
                }
                let types: Vec<String> = if keys.is_empty() { Vec::new() } else { pipe.query_async(&mut c).await? };
                let mut nodes: Vec<TreeNode> = keys
                    .into_iter()
                    .zip(types)
                    .map(|(k, t)| TreeNode { name: k, kind: "key".into(), detail: Some(t), leaf: true })
                    .collect();
                if more {
                    nodes.push(TreeNode {
                        name: format!("… first {TREE_KEYS} keys — use SCAN 0 MATCH pattern* in the console"),
                        kind: "info".into(),
                        detail: None,
                        leaf: true,
                    });
                }
                Ok(nodes)
            }
            _ => Ok(Vec::new()),
        }
    }
}

/// Tách một dòng lệnh thành đối số (khoảng trắng; "…" có escape \n \t \" \\; '…' nguyên văn).
fn tokenize(line: &str) -> anyhow::Result<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                has = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some('n') => cur.push('\n'),
                            Some('t') => cur.push('\t'),
                            Some('r') => cur.push('\r'),
                            Some(c) => cur.push(c),
                            None => anyhow::bail!("Unterminated escape"),
                        },
                        Some(c) => cur.push(c),
                        None => anyhow::bail!("Unterminated \" quote"),
                    }
                }
            }
            '\'' => {
                has = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => anyhow::bail!("Unterminated ' quote"),
                    }
                }
            }
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    Ok(out)
}

fn text(v: &Value) -> String {
    match v {
        Value::Nil => "(nil)".into(),
        Value::Int(i) => i.to_string(),
        Value::BulkString(b) => bytes_text(b),
        Value::SimpleString(s) => s.clone(),
        Value::Okay => "OK".into(),
        Value::Double(d) => d.to_string(),
        Value::Boolean(b) => b.to_string(),
        Value::Array(items) | Value::Set(items) => {
            format!("[{}]", items.iter().map(text).collect::<Vec<_>>().join(", "))
        }
        Value::Map(kv) => format!(
            "{{{}}}",
            kv.iter().map(|(k, v)| format!("{}: {}", text(k), text(v))).collect::<Vec<_>>().join(", ")
        ),
        other => format!("{other:?}"),
    }
}

/// Byte → chuỗi; dữ liệu nhị phân hiển thị kiểu redis-cli ("\xNN").
fn bytes_text(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b
            .iter()
            .map(|&c| if (0x20..0x7f).contains(&c) { (c as char).to_string() } else { format!("\\x{c:02x}") })
            .collect(),
    }
}

fn col(name: &str) -> Column {
    Column { name: name.into(), type_name: None }
}

/// Kết quả một lệnh → bảng. Lệnh trả cặp (HGETALL, CONFIG GET, … WITHSCORES)
/// được ghép thành hai cột.
fn to_result(name: &str, v: Value, limit: usize) -> ResultSet {
    let upper = name.to_ascii_uppercase();
    let pairs = match upper.as_str() {
        "HGETALL" | "CONFIG" => Some(("field", "value")),
        "ZRANGE" | "ZREVRANGE" | "ZRANGEBYSCORE" | "ZREVRANGEBYSCORE" | "ZPOPMIN" | "ZPOPMAX" => Some(("member", "score")),
        _ => None,
    };
    let mut set = ResultSet::default();
    match v {
        Value::Map(kv) => {
            set.columns = vec![col("field"), col("value")];
            for (k, v) in kv {
                set.rows.push(vec![Some(text(&k)), Some(text(&v))]);
            }
        }
        Value::Array(items) | Value::Set(items) => {
            let scalar = items.iter().all(|i| !matches!(i, Value::Array(_) | Value::Map(_) | Value::Set(_)));
            match pairs {
                Some((a, b)) if scalar && items.len() % 2 == 0 && !items.is_empty() => {
                    set.columns = vec![col(a), col(b)];
                    for p in items.chunks(2) {
                        set.rows.push(vec![Some(text(&p[0])), Some(text(&p[1]))]);
                    }
                }
                _ => {
                    set.columns = vec![col("value")];
                    for i in items {
                        set.rows.push(vec![match i {
                            Value::Nil => None,
                            other => Some(text(&other)),
                        }]);
                    }
                }
            }
        }
        Value::Nil => {
            set.columns = vec![col("value")];
            set.rows.push(vec![None]);
        }
        other => {
            set.columns = vec![col("value")];
            set.rows.push(vec![Some(text(&other))]);
        }
    }
    if set.rows.len() > limit {
        set.rows.truncate(limit);
        set.truncated = true;
    }
    set
}
