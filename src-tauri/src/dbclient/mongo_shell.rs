//! Phân tích một tập con cú pháp mongo shell cho console MongoDB:
//!
//!   show dbs | show collections | use <db>
//!   db.<coll>.<method>(args…)[.sort(..).limit(n).skip(n).projection(..).count()]
//!   db.getCollection("name").<method>(…)   db["name"].<method>(…)
//!   db.runCommand({…}) | db.adminCommand({…}) | db.getCollectionNames() | db.stats() | db.dropDatabase()
//!
//! Đối số là literal JS "lỏng" (khoá không nháy, chuỗi '…', ObjectId("…"), ISODate("…"),
//! new Date(), NumberLong(..), NumberDecimal(..), /regex/i…) → đổi sang Extended JSON
//! rồi sang BSON.

use mongodb::bson::{Bson, Document};
use serde_json::{json, Map, Value};

#[derive(Debug, PartialEq)]
pub enum Statement {
    ShowDbs,
    ShowCollections,
    Use(String),
    /// db.<coll>.<method>(args).<chain>…
    Coll { coll: String, method: String, args: Vec<Bson>, chain: Vec<(String, Vec<Bson>)> },
    /// db.<method>(args) — runCommand, adminCommand, getCollectionNames, stats, dropDatabase…
    Db { method: String, args: Vec<Bson> },
}

/// Tách script thành từng câu: theo `;` ở cấp ngoài cùng, hoặc xuống dòng ở cấp ngoài
/// cùng khi dòng sau bắt đầu một câu mới (db. / show / use).
pub fn split_script(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut chars = src.chars().peekable();
    let starts_new = |rest: &str| {
        let t = rest.trim_start();
        t.starts_with("db.") || t.starts_with("db[") || t.starts_with("show ") || t.starts_with("use ")
    };
    let push = |cur: &mut String, out: &mut Vec<String>| {
        let t = cur.trim().trim_end_matches(';').trim().to_string();
        if !t.is_empty() && !t.starts_with("//") {
            out.push(t);
        }
        cur.clear();
    };
    let mut rest_idx = 0usize;
    while let Some(c) = chars.next() {
        rest_idx += c.len_utf8();
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    rest_idx += n.len_utf8();
                    cur.push(n);
                }
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                cur.push(c);
            }
            '/' if chars.peek() == Some(&'/') => {
                // comment tới hết dòng
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    rest_idx += n.len_utf8();
                    chars.next();
                }
            }
            '{' | '[' | '(' => {
                depth += 1;
                cur.push(c);
            }
            '}' | ']' | ')' => {
                depth -= 1;
                cur.push(c);
            }
            ';' if depth <= 0 => push(&mut cur, &mut out),
            '\n' if depth <= 0 && starts_new(&src[rest_idx..]) => push(&mut cur, &mut out),
            _ => cur.push(c),
        }
    }
    push(&mut cur, &mut out);
    out
}

pub fn parse_statement(src: &str) -> anyhow::Result<Statement> {
    let s = src.trim().trim_end_matches(';').trim();
    let lower = s.to_ascii_lowercase();
    if lower == "show dbs" || lower == "show databases" {
        return Ok(Statement::ShowDbs);
    }
    if lower == "show collections" || lower == "show tables" {
        return Ok(Statement::ShowCollections);
    }
    if let Some(db) = s.strip_prefix("use ") {
        return Ok(Statement::Use(db.trim().trim_matches(['"', '\'']).to_string()));
    }
    let mut p = Parser { s: s.as_bytes(), src: s, i: 0 };
    p.expect_word("db")?;
    // db["name"] | db.getCollection("name") | db.name | db.method(
    let coll: Option<String>;
    p.ws();
    if p.peek() == Some(b'[') {
        p.i += 1;
        let v = p.value()?;
        p.ws();
        p.expect(b']')?;
        coll = Some(v.as_str().ok_or_else(|| anyhow::anyhow!("db[...] expects a string"))?.to_string());
    } else {
        p.expect(b'.')?;
        let name = p.ident()?;
        p.ws();
        if p.peek() == Some(b'(') {
            let args = p.args()?;
            if name == "getCollection" {
                let n = args.first().and_then(|a| a.as_str()).ok_or_else(|| anyhow::anyhow!("getCollection(\"name\")"))?;
                coll = Some(n.to_string());
            } else {
                p.ws();
                if p.i < p.s.len() {
                    anyhow::bail!("Unexpected text after db.{name}(…): `{}`", &p.src[p.i..]);
                }
                return Ok(Statement::Db { method: name, args: to_bson(args)? });
            }
        } else {
            coll = Some(name);
        }
    }
    let coll = coll.unwrap();
    p.ws();
    p.expect(b'.')?;
    let method = p.ident()?;
    let args = to_bson(p.args()?)?;
    let mut chain = Vec::new();
    loop {
        p.ws();
        if p.i >= p.s.len() {
            break;
        }
        p.expect(b'.')?;
        let m = p.ident()?;
        let a = to_bson(p.args()?)?;
        chain.push((m, a));
    }
    Ok(Statement::Coll { coll, method, args, chain })
}

fn to_bson(vals: Vec<Value>) -> anyhow::Result<Vec<Bson>> {
    vals.into_iter()
        .map(|v| Bson::try_from(v).map_err(|e| anyhow::anyhow!("Invalid value: {e}")))
        .collect()
}

/// Bson → Document (đối số phải là object).
pub fn as_doc(b: Option<&Bson>, what: &str) -> anyhow::Result<Document> {
    match b {
        None => Ok(Document::new()),
        Some(Bson::Document(d)) => Ok(d.clone()),
        Some(other) => anyhow::bail!("{what} must be an object, got {other}"),
    }
}

struct Parser<'a> {
    s: &'a [u8],
    src: &'a str,
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn ws(&mut self) {
        while let Some(c) = self.peek() {
            if c.is_ascii_whitespace() {
                self.i += 1;
            } else if c == b'/' && self.s.get(self.i + 1) == Some(&b'/') {
                while let Some(c) = self.peek() {
                    if c == b'\n' {
                        break;
                    }
                    self.i += 1;
                }
            } else {
                break;
            }
        }
    }
    fn expect(&mut self, c: u8) -> anyhow::Result<()> {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            let near: String = self.src[self.i.min(self.src.len())..].chars().take(20).collect();
            anyhow::bail!("Expected `{}` near `{near}`", c as char)
        }
    }
    fn expect_word(&mut self, w: &str) -> anyhow::Result<()> {
        self.ws();
        let id = self.ident()?;
        if id != w {
            anyhow::bail!("Expected `{w}` (supported: db.<collection>.<method>(…), db.runCommand(…), show dbs, show collections, use <db>)");
        }
        Ok(())
    }
    fn ident(&mut self) -> anyhow::Result<String> {
        self.ws();
        let start = self.i;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80 {
                self.i += 1;
            } else {
                break;
            }
        }
        if self.i == start {
            let near: String = self.src[start.min(self.src.len())..].chars().take(20).collect();
            anyhow::bail!("Expected a name near `{near}`");
        }
        Ok(self.src[start..self.i].to_string())
    }
    /// `( v, v, … )`
    fn args(&mut self) -> anyhow::Result<Vec<Value>> {
        self.expect(b'(')?;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.peek() == Some(b')') {
                self.i += 1;
                return Ok(out);
            }
            out.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b')') => {}
                _ => anyhow::bail!("Expected `,` or `)` in argument list"),
            }
        }
    }
    fn value(&mut self) -> anyhow::Result<Value> {
        self.ws();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') | Some(b'\'') => Ok(Value::String(self.string()?)),
            Some(b'/') => self.regex(),
            Some(c) if c == b'-' || c == b'+' || c == b'.' || c.is_ascii_digit() => self.number(),
            Some(_) => {
                let id = self.ident()?;
                self.ws();
                match id.as_str() {
                    "true" => Ok(Value::Bool(true)),
                    "false" => Ok(Value::Bool(false)),
                    "null" | "undefined" => Ok(Value::Null),
                    "new" => {
                        let ctor = self.ident()?;
                        self.constructor(&ctor)
                    }
                    _ => self.constructor(&id),
                }
            }
            None => anyhow::bail!("Unexpected end of input"),
        }
    }
    fn constructor(&mut self, name: &str) -> anyhow::Result<Value> {
        let args = if self.peek() == Some(b'(') { self.args()? } else { Vec::new() };
        let first_str = || -> anyhow::Result<String> {
            match args.first() {
                Some(Value::String(s)) => Ok(s.clone()),
                Some(Value::Number(n)) => Ok(n.to_string()),
                _ => anyhow::bail!("{name}(…) needs a value"),
            }
        };
        Ok(match name {
            "ObjectId" => json!({ "$oid": first_str()? }),
            "ISODate" | "Date" => match args.first() {
                None => json!({ "$date": { "$numberLong": now_ms() } }),
                Some(Value::Number(n)) => json!({ "$date": { "$numberLong": n.to_string() } }),
                Some(_) => json!({ "$date": normalize_iso(&first_str()?) }),
            },
            "NumberLong" => json!({ "$numberLong": first_str()? }),
            "NumberInt" => Value::Number(first_str()?.parse::<i32>()?.into()),
            "NumberDecimal" | "Decimal128" => json!({ "$numberDecimal": first_str()? }),
            "UUID" => json!({ "$uuid": first_str()? }),
            "Timestamp" => {
                let t = args.first().and_then(Value::as_u64).unwrap_or(0);
                let i = args.get(1).and_then(Value::as_u64).unwrap_or(0);
                json!({ "$timestamp": { "t": t, "i": i } })
            }
            "MinKey" => json!({ "$minKey": 1 }),
            "MaxKey" => json!({ "$maxKey": 1 }),
            other => anyhow::bail!("Unsupported value `{other}(…)` — use JSON, ObjectId(), ISODate(), NumberLong(), NumberDecimal(), UUID()"),
        })
    }
    fn object(&mut self) -> anyhow::Result<Value> {
        self.expect(b'{')?;
        let mut m = Map::new();
        loop {
            self.ws();
            if self.peek() == Some(b'}') {
                self.i += 1;
                return Ok(Value::Object(m));
            }
            let key = match self.peek() {
                Some(b'"') | Some(b'\'') => self.string()?,
                _ => self.key()?,
            };
            self.expect(b':')?;
            let v = self.value()?;
            m.insert(key, v);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {}
                _ => anyhow::bail!("Expected `,` or `}}` in object"),
            }
        }
    }
    /// Khoá không nháy: chữ, số, _, $, và dấu chấm (vd "a.b" khi viết a.b không được trong JS, nhưng tiện).
    fn key(&mut self) -> anyhow::Result<String> {
        self.ws();
        let start = self.i;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c == b'.' || c >= 0x80 {
                self.i += 1;
            } else {
                break;
            }
        }
        if self.i == start {
            anyhow::bail!("Expected an object key");
        }
        Ok(self.src[start..self.i].to_string())
    }
    fn array(&mut self) -> anyhow::Result<Value> {
        self.expect(b'[')?;
        let mut v = Vec::new();
        loop {
            self.ws();
            if self.peek() == Some(b']') {
                self.i += 1;
                return Ok(Value::Array(v));
            }
            v.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {}
                _ => anyhow::bail!("Expected `,` or `]` in array"),
            }
        }
    }
    fn string(&mut self) -> anyhow::Result<String> {
        let q = self.peek().unwrap();
        self.i += 1;
        let mut out = String::new();
        let rest = &self.src[self.i..];
        let mut it = rest.char_indices();
        while let Some((off, c)) = it.next() {
            match c {
                '\\' => {
                    let Some((_, n)) = it.next() else { break };
                    out.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        '0' => '\0',
                        other => other,
                    });
                }
                c if c as u32 == q as u32 => {
                    self.i += off + 1;
                    return Ok(out);
                }
                c => out.push(c),
            }
        }
        anyhow::bail!("Unterminated string")
    }
    fn regex(&mut self) -> anyhow::Result<Value> {
        self.i += 1; // '/'
        let start = self.i;
        let mut esc = false;
        while let Some(c) = self.peek() {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'/' {
                break;
            }
            self.i += 1;
        }
        let pattern = self.src[start..self.i].to_string();
        self.expect(b'/')?;
        let fstart = self.i;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        let mut flags: Vec<char> = self.src[fstart..self.i].chars().collect();
        flags.sort();
        Ok(json!({ "$regularExpression": { "pattern": pattern, "options": flags.into_iter().collect::<String>() } }))
    }
    fn number(&mut self) -> anyhow::Result<Value> {
        let start = self.i;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || matches!(c, b'-' | b'+' | b'.' | b'e' | b'E')) {
            self.i += 1;
        }
        let t = &self.src[start..self.i];
        if let Ok(n) = t.parse::<i64>() {
            return Ok(Value::Number(n.into()));
        }
        let f: f64 = t.parse().map_err(|_| anyhow::anyhow!("Invalid number `{t}`"))?;
        Ok(json!(f))
    }
}

/// Thời điểm hiện tại (ms) dạng chuỗi cho {"$date": {"$numberLong": …}}.
fn now_ms() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    ms.to_string()
}

/// "2026-10-01" → "2026-10-01T00:00:00Z" (ISODate cho phép ngày trơn).
fn normalize_iso(s: &str) -> Value {
    if s.chars().all(|c| c.is_ascii_digit()) {
        return json!({ "$numberLong": s });
    }
    if s.len() == 10 {
        return Value::String(format!("{s}T00:00:00Z"));
    }
    Value::String(s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_find_chain_with_shell_literals() {
        let st = parse_statement(
            "db.users.find({ age: { $gt: 30 }, _id: ObjectId('65f1c2a9e4b0a1b2c3d4e5f6'), name: /^an/i, \
             at: ISODate(\"2026-10-01\") }, { name: 1 }).sort({ age: -1 }).limit(20);",
        )
        .unwrap();
        let Statement::Coll { coll, method, args, chain } = st else { panic!() };
        assert_eq!((coll.as_str(), method.as_str()), ("users", "find"));
        let filter = args[0].as_document().unwrap();
        assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(filter.get("name"), Some(Bson::RegularExpression(_))));
        assert!(matches!(filter.get("at"), Some(Bson::DateTime(_))));
        assert_eq!(filter.get_document("age").unwrap().get_i32("$gt").unwrap(), 30);
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[1].0, "limit");
    }

    #[test]
    fn parses_db_level_and_get_collection() {
        assert_eq!(parse_statement("show dbs").unwrap(), Statement::ShowDbs);
        assert_eq!(parse_statement("use shop").unwrap(), Statement::Use("shop".into()));
        assert!(matches!(parse_statement("db.runCommand({ ping: 1 })").unwrap(), Statement::Db { .. }));
        let Statement::Coll { coll, .. } = parse_statement("db.getCollection('my-coll').countDocuments({})").unwrap() else { panic!() };
        assert_eq!(coll, "my-coll");
        let Statement::Coll { coll, .. } = parse_statement("db[\"a.b\"].find()").unwrap() else { panic!() };
        assert_eq!(coll, "a.b");
    }

    #[test]
    fn splits_multi_line_script() {
        let s = "db.a.find({\n  x: 1\n})\ndb.b.countDocuments({}) // c\nshow dbs; use x";
        assert_eq!(split_script(s), ["db.a.find({\n  x: 1\n})", "db.b.countDocuments({})", "show dbs", "use x"]);
    }

    #[test]
    fn rejects_garbage_with_helpful_error() {
        let err = parse_statement("SELECT * FROM users").unwrap_err().to_string();
        assert!(err.contains("db.<collection>"), "{err}");
    }
}
