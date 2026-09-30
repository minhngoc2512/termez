//! SPIKE: backend Rust của Termez bọc thành module Node (napi-rs) cho vỏ Electron.
//!
//! Dùng lại NGUYÊN VĂN các module không dính Tauri của app (conn/db/keychain/
//! applock/totp) qua `#[path]`. Chỉ nối những gì cần để thử độ mượt terminal:
//! đọc danh sách host, khoá app, kết nối SSH, gõ phím, resize, output, ngắt.

#![allow(dead_code)]

#[path = "../../src-tauri/src/applock.rs"]
mod applock;
#[path = "../../src-tauri/src/conn.rs"]
mod conn;
#[path = "../../src-tauri/src/db.rs"]
mod db;
#[path = "../../src-tauri/src/keychain.rs"]
mod keychain;
#[path = "../../src-tauri/src/totp.rs"]
mod totp;

use conn::{connect_authenticated, AuthMethod, JumpConfig, ProxyConfig};
use db::Host;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use russh::ChannelMsg;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}
fn napi_err(msg: String) -> napi::Error {
    napi::Error::from_reason(msg)
}

// Callback JS nhận output (Buffer) / sự kiện (chuỗi JSON). CalleeHandled=false:
// JS nhận thẳng giá trị, không có tham số lỗi đứng đầu.
type OutFn = ThreadsafeFunction<Buffer, (), Buffer, Status, false>;
type EvFn = ThreadsafeFunction<String, (), String, Status, false>;

static DB: OnceLock<SqlitePool> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, mpsc::UnboundedSender<SshInput>>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, mpsc::UnboundedSender<SshInput>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn pool() -> R<&'static SqlitePool> {
    DB.get().ok_or_else(|| "native chưa init".to_string())
}

enum SshInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Mở database dùng CHUNG với bản Tauri (cùng file termez.db).
#[napi]
pub async fn init(db_path: String) -> napi::Result<()> {
    if DB.get().is_some() {
        return Ok(());
    }
    let p = db::init_pool(std::path::Path::new(&db_path))
        .await
        .map_err(|err| napi_err(err.to_string()))?;
    let _ = DB.set(p);
    Ok(())
}

// ---------- Các lệnh đọc dữ liệu / khoá app (trả JSON) ----------

const APPLOCK: &str = "applock";
const APPLOCK_TIMEOUT: &str = "applock-timeout";
const APPLOCK_TOTP: &str = "applock-totp";
const APPLOCK_REAUTH: &str = "applock-reauth";

/// Bộ định tuyến chung cho các lệnh không cần callback: nhận/trả JSON.
#[napi]
pub async fn invoke(cmd: String, args_json: String) -> napi::Result<String> {
    let args: Value = serde_json::from_str(&args_json).unwrap_or(Value::Null);
    dispatch(&cmd, &args).await.map(|v| v.to_string()).map_err(napi_err)
}

async fn dispatch(cmd: &str, a: &Value) -> R<Value> {
    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    Ok(match cmd {
        "get_hosts" => json!(db::list_hosts(pool()?).await.map_err(e)?),
        "get_groups" => json!(db::list_groups(pool()?).await.map_err(e)?),
        "get_keys" => json!(db::list_keys(pool()?).await.map_err(e)?),
        "get_tunnels" => json!(db::list_tunnels(pool()?).await.map_err(e)?),
        "get_entries" => json!(db::list_entries(pool()?).await.map_err(e)?),
        "get_vault_folders" => json!(db::list_vault_folders(pool()?).await.map_err(e)?),
        "known_hosts_list" => json!(db::list_known_hosts(pool()?).await.map_err(e)?),
        "known_hosts_add" => {
            let port = a.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
            db::add_known_host(pool()?, &s("host"), port, &s("keyType"), &s("keyB64"), &s("fingerprint"))
                .await
                .map_err(e)?;
            Value::Null
        }
        "applock_status" => {
            let num = |k: &str| {
                keychain::get_secret(k).ok().flatten().and_then(|v| v.parse::<u64>().ok()).unwrap_or(0)
            };
            json!({
                "enabled": keychain::get_secret(APPLOCK).map_err(e)?.is_some(),
                "timeout_mins": num(APPLOCK_TIMEOUT),
                "totp_enabled": keychain::get_secret(APPLOCK_TOTP).map_err(e)?.is_some(),
                "reauth_mins": num(APPLOCK_REAUTH),
            })
        }
        "applock_verify" => match keychain::get_secret(APPLOCK).map_err(e)? {
            Some(phc) => json!(applock::verify(&s("password"), &phc)),
            None => json!(true),
        },
        "applock_unlock" => {
            if let Some(phc) = keychain::get_secret(APPLOCK).map_err(e)? {
                if !applock::verify(&s("password"), &phc) {
                    return Ok(json!(false));
                }
            }
            if let Some(secret) = keychain::get_secret(APPLOCK_TOTP).map_err(e)? {
                if !totp::verify(&secret, &s("code")) {
                    return Ok(json!(false));
                }
            }
            json!(true)
        }
        other => return Err(format!("[electron spike] lệnh chưa hỗ trợ: {other}")),
    })
}

// ---------- Phân giải auth / proxy / jump (chép từ commands.rs) ----------

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

fn resolve_auth(host: &Host) -> R<AuthMethod> {
    match host.auth_type.as_str() {
        "password" => {
            let pw = keychain::get_secret(&keychain::host_password(&host.id))
                .map_err(e)?
                .ok_or_else(|| "Chưa lưu mật khẩu cho host này".to_string())?;
            Ok(AuthMethod::Password(pw))
        }
        "key" => {
            if let Some(kid) = &host.key_id {
                let pem = keychain::get_secret(&keychain::key_secret(kid))
                    .map_err(e)?
                    .ok_or_else(|| "Không tìm thấy private key trong keychain".to_string())?;
                let passphrase = keychain::get_secret(&keychain::key_passphrase(kid)).map_err(e)?;
                Ok(AuthMethod::Key { pem, passphrase })
            } else if let Some(path) = &host.private_key_path {
                let pem = std::fs::read_to_string(expand_tilde(path))
                    .map_err(|err| format!("đọc key file lỗi: {err}"))?;
                let passphrase = keychain::get_secret(&keychain::host_password(&host.id)).map_err(e)?;
                Ok(AuthMethod::Key { pem, passphrase })
            } else {
                Err("Host dùng key nhưng chưa chọn key".into())
            }
        }
        other => Err(format!("auth_type '{other}' chưa hỗ trợ")),
    }
}

fn resolve_proxy(host: &Host) -> R<Option<ProxyConfig>> {
    match host.proxy_type.as_deref() {
        Some(kind) if !kind.is_empty() && kind != "none" => {
            let phost = host.proxy_host.clone().ok_or_else(|| "Proxy thiếu địa chỉ".to_string())?;
            let password = keychain::get_secret(&keychain::proxy_password(&host.id)).map_err(e)?;
            Ok(Some(ProxyConfig {
                kind: kind.to_string(),
                host: phost,
                port: host.proxy_port.unwrap_or(1080) as u16,
                username: host.proxy_username.clone(),
                password,
            }))
        }
        _ => Ok(None),
    }
}

fn resolve_jump<'a>(
    db: &'a SqlitePool,
    host: &'a Host,
    depth: u8,
) -> Pin<Box<dyn Future<Output = R<Option<Box<JumpConfig>>>> + Send + 'a>> {
    Box::pin(async move {
        if depth > 8 {
            return Ok(None);
        }
        let Some(jid) = host.jump_host_id.clone() else {
            return Ok(None);
        };
        let jhost = db::get_host(db, &jid).await.map_err(e)?;
        let auth = resolve_auth(&jhost)?;
        let proxy = resolve_proxy(&jhost)?;
        let inner = resolve_jump(db, &jhost, depth + 1).await?;
        Ok(Some(Box::new(JumpConfig {
            address: jhost.address.clone(),
            port: jhost.port as u16,
            username: jhost.username.clone(),
            auth,
            proxy,
            jump: inner,
        })))
    })
}

fn hostkey_error(err: anyhow::Error, addr: &str, port: u16) -> String {
    let s = err.to_string();
    if let Some(rest) = s.strip_prefix("HOSTKEY\t") {
        let mut it = rest.splitn(4, '\t');
        let kind = it.next().unwrap_or("unknown");
        let algo = it.next().unwrap_or("");
        let fp = it.next().unwrap_or("");
        let openssh = it.next().unwrap_or("");
        return format!("HOSTKEY|{kind}|{addr}|{port}|{algo}|{fp}|{openssh}");
    }
    s
}

// ---------- Phiên SSH (vòng lặp giống ssh.rs của bản Tauri) ----------

const OUT_FLUSH_DELAY: Duration = Duration::from_millis(4);
const OUT_FLUSH_BYTES: usize = 64 * 1024;

fn flush_out(on_data: &OutFn, out: &mut Vec<u8>) {
    if out.is_empty() {
        return;
    }
    let buf = Buffer::from(std::mem::take(out));
    on_data.call(buf, ThreadsafeFunctionCallMode::NonBlocking);
}

/// Kết nối SSH tới host đã lưu. `on_data(Buffer)` nhận output đã gom theo lô;
/// `on_event(json)` nhận {"type":"closed","clean":bool} / {"type":"latency","ms":n}.
#[napi]
pub async fn ssh_connect(
    host_id: String,
    cols: u32,
    rows: u32,
    on_data: OutFn,
    on_event: EvFn,
) -> napi::Result<String> {
    connect_inner(host_id, cols, rows, on_data, on_event).await.map_err(napi_err)
}

async fn connect_inner(host_id: String, cols: u32, rows: u32, on_data: OutFn, on_event: EvFn) -> R<String> {
    let db = pool()?;
    let host = db::get_host(db, &host_id).await.map_err(e)?;
    let auth = resolve_auth(&host)?;
    let proxy = resolve_proxy(&host)?;
    let jump = resolve_jump(db, &host, 0).await?;
    let addr = host.address.clone();
    let port = host.port as u16;
    let expected = db::get_known_host(db, &addr, port).await.map_err(e)?.map(|k| k.fingerprint);

    let conn = connect_authenticated(
        &host.address,
        port,
        &host.username,
        auth,
        host.keepalive != 0,
        proxy,
        jump,
        expected,
        true,
        host.proxy_command.clone(),
    )
    .await
    .map_err(|err| hostkey_error(err, &addr, port))?;

    let mut channel = conn.handle.channel_open_session().await.map_err(e)?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(e)?;
    channel.request_shell(false).await.map_err(e)?;
    if let Some(s) = host.startup_snippet.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let _ = channel.data_bytes(format!("{s}\n").into_bytes()).await;
    }

    let sid = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SshInput>();
    sessions().lock().unwrap().insert(sid.clone(), tx);

    let sid2 = sid.clone();
    tokio::spawn(async move {
        let conn = conn; // giữ kết nối sống suốt phiên
        let mut ping_tick = interval(Duration::from_secs(2));
        let mut clean = false;
        let mut out: Vec<u8> = Vec::new();
        let flush_timer = tokio::time::sleep(Duration::ZERO);
        tokio::pin!(flush_timer);
        let mut flush_armed = false;
        loop {
            tokio::select! {
                _ = &mut flush_timer, if flush_armed => {
                    flush_armed = false;
                    flush_out(&on_data, &mut out);
                }
                _ = ping_tick.tick() => {
                    let t = Instant::now();
                    if let Ok(Ok(())) = tokio::time::timeout(Duration::from_secs(5), conn.handle.send_ping()).await {
                        let ms = t.elapsed().as_millis() as u64;
                        on_event.call(json!({"type": "latency", "ms": ms}).to_string(), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        out.extend_from_slice(&data);
                        if out.len() >= OUT_FLUSH_BYTES {
                            flush_armed = false;
                            flush_out(&on_data, &mut out);
                        } else if !flush_armed {
                            flush_timer.as_mut().reset(tokio::time::Instant::now() + OUT_FLUSH_DELAY);
                            flush_armed = true;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::ExitSignal { .. }) => clean = true,
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => { clean = true; break; }
                    None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(SshInput::Data(b)) => { let _ = channel.data_bytes(b).await; }
                    Some(SshInput::Resize { cols, rows }) => { let _ = channel.window_change(cols, rows, 0, 0).await; }
                    Some(SshInput::Close) | None => { let _ = channel.eof().await; clean = true; break; }
                },
            }
        }
        flush_out(&on_data, &mut out);
        sessions().lock().unwrap().remove(&sid2);
        on_event.call(json!({"type": "closed", "clean": clean}).to_string(), ThreadsafeFunctionCallMode::NonBlocking);
    });

    Ok(sid)
}

fn send_input(id: &str, input: SshInput) {
    if let Some(tx) = sessions().lock().unwrap().get(id) {
        let _ = tx.send(input);
    }
}

#[napi]
pub fn ssh_send(id: String, data: String) {
    send_input(&id, SshInput::Data(data.into_bytes()));
}

#[napi]
pub fn ssh_resize(id: String, cols: u32, rows: u32) {
    send_input(&id, SshInput::Resize { cols, rows });
}

#[napi]
pub fn ssh_disconnect(id: String) {
    if let Some(tx) = sessions().lock().unwrap().remove(&id) {
        let _ = tx.send(SshInput::Close);
    }
}
