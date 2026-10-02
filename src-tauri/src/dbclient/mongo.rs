//! MongoDB qua driver chính thức `mongodb` (TLS rustls + ring).
//!
//! Console nhận một tập con cú pháp mongo shell (xem mongo_shell.rs); kết quả là
//! document → bảng (cột = hợp các khoá cấp 1, giá trị lồng hiển thị dạng JSON).
//! Read-only: chặn mọi thao tác ghi, aggregate có $out/$merge, runCommand ngoài
//! danh sách lệnh đọc.

use super::mongo_shell::{as_doc, parse_statement, split_script, Statement};
use super::{Column, ConnectSpec, MonitorRow, MonitorSnapshot, MonitorTable, ResultSet, TableSizes, TableStat, TreeNode};
use mongodb::bson::{self, doc, Bson, Document};
use futures_util::TryStreamExt;
use mongodb::options::{ClientOptions, Credential, ServerAddress, Tls, TlsOptions};
use mongodb::{Client, Database};
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

/// Comment gắn vào lệnh của editor (để huỷ bằng killOp) và của Monitor (để tự loại khỏi danh sách).
const MONITOR_TAG: &str = "termez-monitor";

const WRITE_METHODS: [&str; 22] = [
    "insertOne", "insertMany", "insert", "save", "updateOne", "updateMany", "update", "replaceOne",
    "deleteOne", "deleteMany", "remove", "drop", "createIndex", "createIndexes", "dropIndex", "dropIndexes",
    "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace", "bulkWrite", "renameCollection", "dropDatabase",
];
const READ_COMMANDS: [&str; 22] = [
    "ping", "buildInfo", "buildinfo", "serverStatus", "dbStats", "dbstats", "collStats", "listCollections",
    "listIndexes", "listDatabases", "count", "distinct", "find", "aggregate", "hostInfo", "connectionStatus",
    "isMaster", "ismaster", "hello", "explain", "currentOp", "top",
];

pub struct MongoSession {
    client: Client,
    current_db: Mutex<String>,
    default_db: Option<String>,
    read_only: bool,
    cancel: Notify,
    /// comment của lệnh editor đang chạy (để killOp khi huỷ).
    running: std::sync::Mutex<Option<String>>,
}

fn opt(spec: &ConnectSpec, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(spec.options.as_deref()?).ok()?;
    v.get(key)?.as_str().map(str::to_string).filter(|s| !s.trim().is_empty())
}

fn tls_for(spec: &ConnectSpec, enabled: bool) -> Tls {
    if !enabled {
        return Tls::Disabled;
    }
    // Qua tunnel driver nối 127.0.0.1 nên không thể kiểm tên chứng chỉ (kênh đã được SSH mã
    // hoá); "require"/"prefer" cũng không kiểm chứng chỉ (DB tự host hay dùng chứng chỉ tự ký).
    let tunneled = spec.host != spec.tls_host;
    let lax = spec.ssl_mode != "verify" || tunneled;
    Tls::Enabled(TlsOptions::builder().allow_invalid_certificates(lax).build())
}

async fn build_client(spec: &ConnectSpec, tls: bool) -> anyhow::Result<Client> {
    let mut o = match opt(spec, "uri") {
        Some(uri) => {
            if spec.host != spec.tls_host {
                anyhow::bail!("A connection string can't be combined with an SSH tunnel — use host/port instead.");
            }
            ClientOptions::parse(&uri).await?
        }
        None => {
            let mut o = ClientOptions::default();
            o.hosts = vec![ServerAddress::Tcp { host: spec.host.clone(), port: Some(spec.port) }];
            // Một máy chủ cụ thể (kể cả qua tunnel): không dò replica set sang hostname nội bộ.
            o.direct_connection = Some(true);
            o.tls = Some(tls_for(spec, tls));
            o
        }
    };
    if !spec.username.is_empty() {
        let mut c = Credential::default();
        c.username = Some(spec.username.clone());
        c.password = Some(spec.password.clone());
        c.source = Some(opt(spec, "authSource").unwrap_or_else(|| "admin".into()));
        o.credential = Some(c);
    }
    o.app_name = Some("Termez".into());
    o.connect_timeout = Some(Duration::from_secs(15));
    o.server_selection_timeout = Some(Duration::from_secs(15));
    Ok(Client::with_options(o)?)
}

/// Server có nhận TLS không: bắt tay thử (mongod không bật TLS đóng kết nối ngay khi
/// nhận ClientHello vì đọc ra độ dài message vô lý).
async fn tls_available(spec: &ConnectSpec) -> bool {
    let (host, port, sni) = (spec.host.clone(), spec.port, spec.tls_host.clone());
    let probe = move || -> anyhow::Result<()> {
        use std::net::{TcpStream, ToSocketAddrs};
        let addr = (host.as_str(), port).to_socket_addrs()?.next().ok_or_else(|| anyhow::anyhow!("no address"))?;
        let mut sock = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
        sock.set_read_timeout(Some(Duration::from_secs(5)))?;
        sock.set_write_timeout(Some(Duration::from_secs(5)))?;
        let name = rustls::pki_types::ServerName::try_from(sni)?;
        let mut conn = rustls::ClientConnection::new(std::sync::Arc::new(super::tls::client_config(false)?), name)?;
        while conn.is_handshaking() {
            conn.complete_io(&mut sock)?;
        }
        Ok(())
    };
    matches!(tokio::task::spawn_blocking(probe).await, Ok(Ok(())))
}

/// Số từ BSON (Int32/Int64/Double).
fn bnum(b: Option<&Bson>) -> Option<f64> {
    match b? {
        Bson::Int32(i) => Some(*i as f64),
        Bson::Int64(i) => Some(*i as f64),
        Bson::Double(d) => Some(*d),
        Bson::Decimal128(d) => d.to_string().parse().ok(),
        _ => None,
    }
}

/// Tên kiểu theo alias của MongoDB ($type) — dùng làm chi tiết trường trong cây.
fn type_alias(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "object",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Timestamp(_) => "timestamp",
        Bson::Int64(_) => "long",
        Bson::Decimal128(_) => "decimal",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        _ => "other",
    }
}

/// Giá trị BSON → chuỗi hiển thị trong lưới (lồng → JSON gọn).
fn show(b: &Bson) -> Option<String> {
    Some(match b {
        Bson::Null | Bson::Undefined => return None,
        Bson::String(s) => s.clone(),
        Bson::Int32(i) => i.to_string(),
        Bson::Int64(i) => i.to_string(),
        Bson::Double(d) => d.to_string(),
        Bson::Decimal128(d) => d.to_string(),
        Bson::Boolean(v) => v.to_string(),
        Bson::ObjectId(o) => format!("ObjectId(\"{o}\")"),
        Bson::DateTime(d) => d.try_to_rfc3339_string().unwrap_or_else(|_| d.to_string()),
        other => other.clone().into_relaxed_extjson().to_string(),
    })
}

/// Documents → bảng: cột là hợp các khoá cấp 1 theo thứ tự xuất hiện (_id đầu tiên).
fn docs_to_set(docs: Vec<Document>, limit: usize) -> ResultSet {
    let mut cols: Vec<String> = Vec::new();
    for d in &docs {
        for k in d.keys() {
            if !cols.iter().any(|c| c == k) {
                if k == "_id" {
                    cols.insert(0, k.clone());
                } else {
                    cols.push(k.clone());
                }
            }
        }
    }
    let truncated = docs.len() > limit;
    let rows = docs
        .iter()
        .take(limit)
        .map(|d| cols.iter().map(|c| d.get(c).and_then(show)).collect())
        .collect();
    ResultSet {
        columns: cols.into_iter().map(|name| Column { name, type_name: None }).collect(),
        rows,
        truncated,
        ..Default::default()
    }
}

/// Document → bảng 2 cột field/value (kết quả runCommand, stats…).
fn kv_set(d: &Document) -> ResultSet {
    ResultSet {
        columns: vec![Column { name: "field".into(), type_name: None }, Column { name: "value".into(), type_name: None }],
        rows: d.iter().map(|(k, v)| vec![Some(k.clone()), show(v)]).collect(),
        ..Default::default()
    }
}

fn single(name: &str, values: Vec<Option<String>>) -> ResultSet {
    ResultSet {
        columns: vec![Column { name: name.into(), type_name: None }],
        rows: values.into_iter().map(|v| vec![v]).collect(),
        ..Default::default()
    }
}

fn affected(n: u64) -> ResultSet {
    ResultSet { affected: Some(n), ..Default::default() }
}

fn pipeline_writes(stages: &[Document]) -> bool {
    stages.iter().any(|s| s.contains_key("$out") || s.contains_key("$merge"))
}

/// Đối số aggregate: một mảng stage, hoặc các stage rời.
fn pipeline_of(args: &[Bson]) -> anyhow::Result<Vec<Document>> {
    let items: Vec<Bson> = match args.first() {
        Some(Bson::Array(a)) => a.clone(),
        _ => args.to_vec(),
    };
    items
        .into_iter()
        .map(|b| match b {
            Bson::Document(d) => Ok(d),
            other => anyhow::bail!("Pipeline stages must be objects, got {other}"),
        })
        .collect()
}

impl MongoSession {
    pub async fn connect(spec: &ConnectSpec) -> anyhow::Result<(Self, String)> {
        // Driver dựng TLS bằng provider mặc định của rustls → cài `ring`.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = match spec.ssl_mode.as_str() {
            "disable" => false,
            "require" | "verify" => true,
            // prefer: thử bắt tay TLS trước — driver không tự lùi về kết nối thường mà
            // chờ hết server_selection_timeout, nên dò riêng cho nhanh.
            _ => opt(spec, "uri").is_none() && tls_available(spec).await,
        };
        let client = build_client(spec, tls).await?;
        let info = client.database("admin").run_command(doc! { "buildInfo": 1 }).await?;
        let version = info.get_str("version").unwrap_or("").to_string();
        let default_db = spec.database.clone().filter(|d| !d.is_empty());
        let s = Self {
            client,
            current_db: Mutex::new(default_db.clone().unwrap_or_else(|| "test".into())),
            default_db,
            read_only: spec.read_only,
            cancel: Notify::new(),
            running: std::sync::Mutex::new(None),
        };
        Ok((s, version))
    }

    pub async fn current_database(&self) -> Option<String> {
        Some(self.current_db.lock().await.clone())
    }

    pub fn default_database(&self) -> Option<String> {
        self.default_db.clone()
    }

    fn check_read_only(&self, st: &Statement) -> anyhow::Result<()> {
        if !self.read_only {
            return Ok(());
        }
        let blocked = match st {
            Statement::Coll { method, args, .. } => {
                WRITE_METHODS.contains(&method.as_str())
                    || (method == "aggregate" && pipeline_writes(&pipeline_of(args).unwrap_or_default()))
            }
            Statement::Db { method, args } => match method.as_str() {
                "runCommand" | "adminCommand" => match args.first() {
                    Some(Bson::Document(d)) => {
                        let cmd = d.keys().next().map(String::as_str).unwrap_or("");
                        let pipe = d.get_array("pipeline").ok().map(|p| {
                            p.iter().filter_map(|s| s.as_document().cloned()).collect::<Vec<_>>()
                        });
                        !READ_COMMANDS.contains(&cmd) || pipe.is_some_and(|p| pipeline_writes(&p))
                    }
                    _ => true,
                },
                "getCollectionNames" | "stats" | "serverStatus" | "version" => false,
                _ => true,
            },
            _ => false,
        };
        if blocked {
            anyhow::bail!(
                "Read-only connection — blocked. Only reads (find, aggregate without $out/$merge, count, distinct, \
                 read-only commands) can run. Edit the connection and untick Read-only to make changes."
            );
        }
        Ok(())
    }

    pub async fn query(
        &self,
        database: Option<String>,
        script: &str,
        limit: usize,
    ) -> anyhow::Result<(Vec<ResultSet>, Option<String>)> {
        if let Some(db) = database {
            *self.current_db.lock().await = db;
        }
        let mut sets = Vec::new();
        for src in split_script(script) {
            let st = parse_statement(&src)?;
            self.check_read_only(&st)?;
            let tag = format!("termez-{}", uuid::Uuid::new_v4().simple());
            *self.running.lock().unwrap() = Some(tag.clone());
            let res = tokio::select! {
                r = self.exec(st, limit, &tag) => r,
                _ = self.cancel.notified() => Err(anyhow::anyhow!("Cancelled")),
            };
            *self.running.lock().unwrap() = None;
            sets.push(res?);
        }
        Ok((sets, Some(self.current_db.lock().await.clone())))
    }

    fn db(&self, name: &str) -> Database {
        self.client.database(name)
    }

    async fn exec(&self, st: Statement, limit: usize, tag: &str) -> anyhow::Result<ResultSet> {
        let dbname = self.current_db.lock().await.clone();
        let db = self.db(&dbname);
        let comment = Bson::String(tag.to_string());
        Ok(match st {
            Statement::ShowDbs => {
                let dbs = self.client.list_databases().await?;
                ResultSet {
                    columns: ["name", "size on disk", "empty"].map(|n| Column { name: n.into(), type_name: None }).to_vec(),
                    rows: dbs
                        .iter()
                        .map(|d| vec![Some(d.name.clone()), Some(d.size_on_disk.to_string()), Some(d.empty.to_string())])
                        .collect(),
                    ..Default::default()
                }
            }
            Statement::ShowCollections => {
                let mut names = db.list_collection_names().await?;
                names.sort();
                single("collection", names.into_iter().map(Some).collect())
            }
            Statement::Use(name) => {
                *self.current_db.lock().await = name.clone();
                single("result", vec![Some(format!("switched to db {name}"))])
            }
            Statement::Db { method, args } => match method.as_str() {
                "runCommand" => kv_set(&db.run_command(as_doc(args.first(), "runCommand")?).await?),
                "adminCommand" => kv_set(&self.db("admin").run_command(as_doc(args.first(), "adminCommand")?).await?),
                "getCollectionNames" => {
                    let mut names = db.list_collection_names().await?;
                    names.sort();
                    single("collection", names.into_iter().map(Some).collect())
                }
                "stats" => kv_set(&db.run_command(doc! { "dbStats": 1 }).await?),
                "serverStatus" => kv_set(&self.db("admin").run_command(doc! { "serverStatus": 1 }).await?),
                "version" => {
                    let info = self.db("admin").run_command(doc! { "buildInfo": 1 }).await?;
                    single("version", vec![info.get_str("version").ok().map(str::to_string)])
                }
                "dropDatabase" => {
                    db.drop().await?;
                    single("result", vec![Some(format!("dropped {dbname}"))])
                }
                other => anyhow::bail!("db.{other}() isn't supported — use db.runCommand({{…}})"),
            },
            Statement::Coll { coll, method, args, chain } => {
                let c = db.collection::<Document>(&coll);
                let arg_doc = |i: usize, what: &str| as_doc(args.get(i), what);
                match method.as_str() {
                    "find" => {
                        let mut f = c.find(arg_doc(0, "filter")?).comment(comment);
                        if let Some(Bson::Document(p)) = args.get(1) {
                            f = f.projection(p.clone());
                        }
                        let mut user_limit: Option<i64> = None;
                        for (m, a) in &chain {
                            match m.as_str() {
                                "sort" => f = f.sort(as_doc(a.first(), "sort")?),
                                "projection" => f = f.projection(as_doc(a.first(), "projection")?),
                                "skip" => f = f.skip(a.first().and_then(|b| bnum(Some(b))).unwrap_or(0.0) as u64),
                                "limit" => user_limit = a.first().and_then(|b| bnum(Some(b))).map(|n| n as i64),
                                "count" => {
                                    let n = c.count_documents(arg_doc(0, "filter")?).await?;
                                    return Ok(single("count", vec![Some(n.to_string())]));
                                }
                                "pretty" | "toArray" => {}
                                other => anyhow::bail!(".{other}() isn't supported after find()"),
                            }
                        }
                        // Lấy dư 1 để biết có bị cắt theo giới hạn dòng không.
                        let cap = (limit + 1) as i64;
                        let l = user_limit.filter(|l| *l > 0).map(|l| l.min(cap)).unwrap_or(cap);
                        let docs: Vec<Document> = f.limit(l).await?.try_collect().await?;
                        docs_to_set(docs, limit)
                    }
                    "findOne" => {
                        let mut f = c.find_one(arg_doc(0, "filter")?).comment(comment);
                        if let Some(Bson::Document(p)) = args.get(1) {
                            f = f.projection(p.clone());
                        }
                        docs_to_set(f.await?.into_iter().collect(), limit)
                    }
                    "countDocuments" | "count" => {
                        let n = c.count_documents(arg_doc(0, "filter")?).comment(comment).await?;
                        single("count", vec![Some(n.to_string())])
                    }
                    "estimatedDocumentCount" => single("count", vec![Some(c.estimated_document_count().await?.to_string())]),
                    "aggregate" => {
                        let mut cur = c.aggregate(pipeline_of(&args)?).comment(comment).await?;
                        let mut docs = Vec::new();
                        while let Some(d) = cur.try_next().await? {
                            docs.push(d);
                            if docs.len() > limit {
                                break;
                            }
                        }
                        docs_to_set(docs, limit)
                    }
                    "distinct" => {
                        let field = args.first().and_then(Bson::as_str).ok_or_else(|| anyhow::anyhow!("distinct(\"field\", filter)"))?;
                        let vals = c.distinct(field, arg_doc(1, "filter")?).await?;
                        let mut set = single(field, vals.iter().take(limit).map(show).collect());
                        set.truncated = vals.len() > limit;
                        set
                    }
                    "insertOne" => {
                        c.insert_one(arg_doc(0, "document")?).await?;
                        affected(1)
                    }
                    "insertMany" => {
                        let docs: Vec<Document> = match args.first() {
                            Some(Bson::Array(a)) => a.iter().filter_map(|b| b.as_document().cloned()).collect(),
                            _ => anyhow::bail!("insertMany([ {{…}}, … ])"),
                        };
                        affected(c.insert_many(docs).await?.inserted_ids.len() as u64)
                    }
                    "updateOne" | "updateMany" => {
                        let (f, u) = (arg_doc(0, "filter")?, arg_doc(1, "update")?);
                        let upsert = as_doc(args.get(2), "options")?.get_bool("upsert").unwrap_or(false);
                        let r = if method == "updateOne" {
                            c.update_one(f, u).upsert(upsert).await?
                        } else {
                            c.update_many(f, u).upsert(upsert).await?
                        };
                        ResultSet {
                            columns: ["matched", "modified", "upserted id"].map(|n| Column { name: n.into(), type_name: None }).to_vec(),
                            rows: vec![vec![
                                Some(r.matched_count.to_string()),
                                Some(r.modified_count.to_string()),
                                r.upserted_id.as_ref().and_then(show),
                            ]],
                            affected: Some(r.modified_count),
                            ..Default::default()
                        }
                    }
                    "replaceOne" => {
                        let r = c.replace_one(arg_doc(0, "filter")?, arg_doc(1, "replacement")?).await?;
                        affected(r.modified_count)
                    }
                    "deleteOne" => affected(c.delete_one(arg_doc(0, "filter")?).await?.deleted_count),
                    "deleteMany" => affected(c.delete_many(arg_doc(0, "filter")?).await?.deleted_count),
                    "drop" => {
                        c.drop().await?;
                        single("result", vec![Some(format!("dropped {coll}"))])
                    }
                    "getIndexes" => {
                        let idx: Vec<_> = c.list_indexes().await?.try_collect().await?;
                        let docs = idx
                            .into_iter()
                            .map(|m| {
                                let mut d = doc! { "keys": m.keys };
                                if let Some(o) = m.options.and_then(|o| bson::to_document(&o).ok()) {
                                    for (k, v) in o {
                                        d.insert(k, v);
                                    }
                                }
                                d
                            })
                            .collect();
                        docs_to_set(docs, limit)
                    }
                    "createIndex" => {
                        let model = mongodb::IndexModel::builder().keys(arg_doc(0, "keys")?).build();
                        let r = c.create_index(model).await?;
                        single("index", vec![Some(r.index_name)])
                    }
                    "dropIndex" => {
                        let name = args.first().and_then(Bson::as_str).ok_or_else(|| anyhow::anyhow!("dropIndex(\"name\")"))?;
                        c.drop_index(name).await?;
                        single("result", vec![Some(format!("dropped index {name}"))])
                    }
                    "stats" => {
                        let mut cur = c.aggregate([doc! { "$collStats": { "storageStats": {} } }]).await?;
                        let d = cur.try_next().await?.unwrap_or_default();
                        kv_set(d.get_document("storageStats").unwrap_or(&d))
                    }
                    other => anyhow::bail!(
                        "db.{coll}.{other}() isn't supported — try find, findOne, aggregate, countDocuments, distinct, \
                         insertOne/Many, updateOne/Many, deleteOne/Many, getIndexes"
                    ),
                }
            }
        })
    }

    /// Huỷ lệnh editor đang chạy: bỏ chờ ngay + killOp theo comment (nếu có quyền).
    pub async fn cancel(&self) -> anyhow::Result<()> {
        self.cancel.notify_waiters();
        let tag = self.running.lock().unwrap().clone();
        if let Some(tag) = tag {
            let admin = self.db("admin");
            if let Ok(mut cur) = admin
                .aggregate([
                    doc! { "$currentOp": { "allUsers": true, "idleConnections": false } },
                    doc! { "$match": { "command.comment": &tag } },
                ])
                .await
            {
                while let Ok(Some(op)) = cur.try_next().await {
                    if let Some(id) = op.get("opid") {
                        let _ = admin.run_command(doc! { "killOp": 1, "op": id.clone() }).await;
                    }
                }
            }
        }
        Ok(())
    }

    /// Cây: [] → databases; [db] → collections; [db, coll] → các trường (lấy mẫu 50 document).
    pub async fn tree(&self, path: &[String]) -> anyhow::Result<Vec<TreeNode>> {
        Ok(match path {
            [] => {
                let mut names = self.client.list_database_names().await?;
                names.sort();
                names.into_iter().map(|name| TreeNode { name, kind: "database".into(), detail: None, leaf: false }).collect()
            }
            [db] => {
                let mut names = self.db(db).list_collection_names().await?;
                names.sort();
                names.into_iter().map(|name| TreeNode { name, kind: "collection".into(), detail: None, leaf: false }).collect()
            }
            [db, coll] => {
                let docs: Vec<Document> =
                    self.db(db).collection::<Document>(coll).find(doc! {}).limit(50).await?.try_collect().await?;
                let mut fields: Vec<(String, String)> = Vec::new();
                for d in &docs {
                    for (k, v) in d {
                        if !fields.iter().any(|(f, _)| f == k) {
                            fields.push((k.clone(), type_alias(v).to_string()));
                        }
                    }
                }
                fields
                    .into_iter()
                    .map(|(name, ty)| TreeNode { detail: Some(if name == "_id" { format!("{ty} · PK") } else { ty }), name, kind: "column".into(), leaf: true })
                    .collect()
            }
            _ => Vec::new(),
        })
    }

    /// Monitor: serverStatus (bộ đếm + tức thời), $currentOp (huỷ được bằng killOp).
    pub async fn monitor(&self, breakdown: bool) -> anyhow::Result<MonitorSnapshot> {
        let admin = self.db("admin");
        let ss = admin.run_command(doc! { "serverStatus": 1 }).await?;
        let mut snap = MonitorSnapshot::default();
        let mut put = |k: &str, v: Option<f64>| {
            if let Some(v) = v {
                snap.values.insert(k.to_string(), v);
            }
        };
        if let Ok(op) = ss.get_document("opcounters") {
            for k in ["insert", "query", "update", "delete", "getmore", "command"] {
                put(&format!("op_{k}"), bnum(op.get(k)));
            }
        }
        if let Ok(c) = ss.get_document("connections") {
            put("conn_current", bnum(c.get("current")));
            put("conn_available", bnum(c.get("available")));
        }
        if let Ok(n) = ss.get_document("network") {
            put("net_in", bnum(n.get("bytesIn")));
            put("net_out", bnum(n.get("bytesOut")));
        }
        if let Ok(m) = ss.get_document("mem") {
            put("mem_resident_mb", bnum(m.get("resident")));
        }
        if let Ok(c) = ss.get_document("wiredTiger").and_then(|w| w.get_document("cache")) {
            put("wt_cache_bytes", bnum(c.get("bytes currently in the cache")));
            put("wt_cache_max", bnum(c.get("maximum bytes configured")));
        }
        if let Ok(q) = ss.get_document("globalLock").and_then(|g| g.get_document("currentQueue")) {
            put("queued", bnum(q.get("total")));
        }
        put("uptime", bnum(ss.get("uptime")));

        let mut cur = admin
            .aggregate([
                doc! { "$currentOp": { "allUsers": true, "idleConnections": false } },
                // Bỏ luồng nội bộ (op "none") và heartbeat `hello` chờ sẵn của các driver.
                doc! { "$match": {
                    "active": true,
                    "op": { "$ne": "none" },
                    "command.comment": { "$ne": MONITOR_TAG },
                    "command.hello": { "$exists": false },
                    "command.isMaster": { "$exists": false },
                    "command.ismaster": { "$exists": false },
                } },
            ])
            .comment(Bson::String(MONITOR_TAG.into()))
            .await?;
        let mut rows = Vec::new();
        while let Some(op) = cur.try_next().await? {
            let Some(opid) = op.get("opid").and_then(show) else { continue };
            let ns = op.get_str("ns").unwrap_or("").to_string();
            let db = ns.split('.').next().filter(|s| !s.is_empty()).map(str::to_string);
            let user = op
                .get_array("effectiveUsers")
                .ok()
                .and_then(|u| u.first())
                .and_then(Bson::as_document)
                .and_then(|u| u.get_str("user").ok())
                .map(str::to_string);
            // Bỏ trường phiên/định tuyến của driver cho câu lệnh dễ đọc (db đã có cột riêng).
            let mut cmd = op.get_document("command").cloned().unwrap_or_default();
            for k in ["lsid", "$clusterTime", "$db", "$readPreference", "txnNumber", "autocommit", "startTransaction", "apiVersion"] {
                cmd.remove(k);
            }
            let mut query = Bson::Document(cmd).into_relaxed_extjson().to_string();
            if query.len() > 500 {
                let mut cut = 500;
                while !query.is_char_boundary(cut) {
                    cut -= 1;
                }
                query.truncate(cut);
                query.push('…');
            }
            rows.push(MonitorRow {
                id: Some(opid.clone()),
                cells: vec![
                    Some(opid),
                    user,
                    db,
                    op.get_str("op").ok().map(str::to_string),
                    op.get("secs_running").and_then(show),
                    op.get_str("client").ok().map(str::to_string),
                    Some(query),
                ],
            });
            if rows.len() >= 200 {
                break;
            }
        }
        snap.tables.push(MonitorTable {
            title: "Running operations".into(),
            columns: ["opid", "user", "db", "op", "time (s)", "client", "query"].map(String::from).to_vec(),
            rows,
            killable: true,
        });
        if breakdown {
            let dbs = self.client.list_databases().await?;
            let mut list: Vec<(String, f64)> = dbs.iter().map(|d| (d.name.clone(), d.size_on_disk as f64)).collect();
            list.sort_by(|a, b| b.1.total_cmp(&a.1));
            snap.breakdown = Some(list);
        }
        Ok(snap)
    }

    /// killOp theo opid (Running operations của Monitor).
    pub async fn kill(&self, target: &str) -> anyhow::Result<()> {
        let id: Bson = match target.parse::<i64>() {
            Ok(n) if i32::try_from(n).is_ok() => Bson::Int32(n as i32),
            Ok(n) => Bson::Int64(n),
            Err(_) => Bson::String(target.to_string()), // sharded cluster: "shard:opid"
        };
        self.db("admin").run_command(doc! { "killOp": 1, "op": id }).await?;
        Ok(())
    }

    /// Dung lượng + số document từng collection ($collStats storageStats).
    pub async fn table_sizes(&self, database: &str) -> anyhow::Result<TableSizes> {
        let db = self.db(database);
        let mut names = db.list_collection_names().await?;
        names.sort();
        let mut tables = Vec::new();
        for name in names.into_iter().take(1000) {
            let Ok(mut cur) = db.collection::<Document>(&name).aggregate([doc! { "$collStats": { "storageStats": {} } }]).await else {
                continue; // view / system collection
            };
            let Ok(Some(d)) = cur.try_next().await else { continue };
            let Ok(s) = d.get_document("storageStats") else { continue };
            let storage = bnum(s.get("storageSize")).unwrap_or(0.0);
            let index = bnum(s.get("totalIndexSize")).unwrap_or(0.0);
            tables.push(TableStat {
                name,
                engine: None,
                rows: bnum(s.get("count")),
                total_bytes: storage + index,
                data_bytes: Some(storage),
                index_bytes: Some(index),
                uncompressed_bytes: None,
            });
        }
        tables.sort_by(|a, b| b.total_bytes.total_cmp(&a.total_bytes));
        Ok(TableSizes { tables, rows_exact: true })
    }
}
