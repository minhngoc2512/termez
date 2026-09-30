//! Backend Rust của Termez cho bản Electron, bọc thành module Node (napi-rs).
//!
//! Toàn bộ backend được nạp NGUYÊN VĂN từ `src-tauri/src` qua `#[path]`. Những chỗ
//! backend gọi `tauri::…` được crate giả `tauri` (native/tauri-shim) cài lại,
//! chuyển sự kiện / output sang JS qua các callback dưới đây. Bộ định tuyến lệnh
//! (`dispatch`) được sinh tự động từ commands.rs trong build.rs.

#![allow(dead_code)]

#[path = "../../src-tauri/src/applock.rs"]
mod applock;
#[path = "../../src-tauri/src/cloudflare.rs"]
mod cloudflare;
#[path = "../../src-tauri/src/commands.rs"]
mod commands;
#[path = "../../src-tauri/src/conn.rs"]
mod conn;
#[path = "../../src-tauri/src/db.rs"]
mod db;
#[path = "../../src-tauri/src/keychain.rs"]
mod keychain;
#[path = "../../src-tauri/src/keys.rs"]
mod keys;
#[path = "../../src-tauri/src/monitor.rs"]
mod monitor;
#[path = "../../src-tauri/src/s3.rs"]
mod s3;
#[path = "../../src-tauri/src/scan.rs"]
mod scan;
#[path = "../../src-tauri/src/sftp.rs"]
mod sftp;
#[path = "../../src-tauri/src/ssh.rs"]
mod ssh;
#[path = "../../src-tauri/src/sync.rs"]
mod sync;
#[path = "../../src-tauri/src/totp.rs"]
mod totp;
#[path = "../../src-tauri/src/tunnel.rs"]
mod tunnel;

use commands::AppState;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tauri::ipc::InvokeResponseBody;

// ---------- Cầu nối sự kiện / Channel sang JS ----------

// CalleeHandled=false: JS nhận thẳng giá trị, không có tham số lỗi đứng đầu.
type StrFn = ThreadsafeFunction<String, (), String, Status, false>;
type BufFn = ThreadsafeFunction<Buffer, (), Buffer, Status, false>;

/// Cài `tauri::Host`: đẩy sự kiện và output Channel sang tiến trình chính Electron.
struct JsHost {
    on_event: StrFn,
    on_channel: BufFn,
}

impl tauri::Host for JsHost {
    fn emit(&self, event: &str, payload_json: String) {
        let ev = serde_json::to_string(event).unwrap_or_else(|_| "\"\"".into());
        let msg = format!("{{\"event\":{ev},\"payload\":{payload_json}}}");
        self.on_event.call(msg, ThreadsafeFunctionCallMode::NonBlocking);
    }

    /// Khung nhị phân: [id u32 LE][index u64 LE][kind u8: 0 = byte thô, 1 = JSON][dữ liệu].
    fn channel(&self, id: u32, index: u64, body: InvokeResponseBody) {
        let (kind, data) = match body {
            InvokeResponseBody::Raw(b) => (0u8, b),
            InvokeResponseBody::Json(s) => (1u8, s.into_bytes()),
        };
        let mut frame = Vec::with_capacity(13 + data.len());
        frame.extend_from_slice(&id.to_le_bytes());
        frame.extend_from_slice(&index.to_le_bytes());
        frame.push(kind);
        frame.extend_from_slice(&data);
        self.on_channel.call(Buffer::from(frame), ThreadsafeFunctionCallMode::NonBlocking);
    }

    fn restart(&self) {
        self.emit("__termez_restart", "null".into());
    }
}

static STATE: OnceLock<&'static AppState> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Khởi tạo: mở database (dùng CHUNG thư mục dữ liệu với bản Tauri) và dựng
/// AppState giống hệt `src-tauri/src/lib.rs`.
#[napi]
pub async fn init(data_dir: String, on_event: StrFn, on_channel: BufFn) -> napi::Result<()> {
    if STATE.get().is_some() {
        return Ok(());
    }
    let data_dir = std::path::PathBuf::from(data_dir);
    std::fs::create_dir_all(&data_dir).ok();
    let pool = db::init_pool(&data_dir.join("termez.db"))
        .await
        .map_err(|e| napi::Error::from_reason(format!("khởi tạo database thất bại: {e}")))?;
    let state: &'static AppState = Box::leak(Box::new(AppState {
        db: pool,
        ssh: ssh::SshManager::new(),
        sftp: Arc::new(sftp::SftpManager::new()),
        tunnels: Arc::new(tunnel::TunnelManager::new()),
        autosync: std::sync::Mutex::new(None),
        dirty: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        monitor: Arc::new(monitor::MonitorManager::new()),
        sync_base_path: data_dir.join("sync-base.enc"),
    }));
    let _ = STATE.set(state);
    let _ = APP.set(tauri::AppHandle::new(Arc::new(JsHost { on_event, on_channel })));
    Ok(())
}

/// Gọi một lệnh backend (giống `invoke` của Tauri). Nhận/trả JSON; lỗi là chuỗi
/// y như Tauri (vd "HOSTKEY|…").
#[napi]
pub async fn invoke(cmd: String, args_json: String) -> napi::Result<String> {
    let (Some(state), Some(app)) = (STATE.get(), APP.get()) else {
        return Err(napi::Error::from_reason("native chưa init"));
    };
    let args: Value = serde_json::from_str(&args_json).unwrap_or(Value::Null);
    dispatch::dispatch(&cmd, &args, app, state)
        .await
        .map(|v| v.to_string())
        .map_err(napi::Error::from_reason)
}

/// Số lệnh backend đã nối (để kiểm tra).
#[napi]
pub fn command_count() -> u32 {
    dispatch::COMMAND_COUNT as u32
}

mod dispatch {
    use serde::de::DeserializeOwned;
    use serde::Serialize;
    use serde_json::Value;

    /// Lấy tham số `k` (camelCase) từ JSON. Thiếu → null (Option sẽ thành None).
    fn arg<T: DeserializeOwned>(a: &Value, k: &str) -> Result<T, String> {
        let v = a.get(k).cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| format!("tham số '{k}' không hợp lệ: {e}"))
    }

    /// Channel phía JS gửi lên dạng "__CHANNEL__:<id>".
    fn channel_arg<T>(a: &Value, k: &str, app: &tauri::AppHandle) -> Result<tauri::ipc::Channel<T>, String> {
        let s = a.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let id = s
            .strip_prefix("__CHANNEL__:")
            .and_then(|n| n.parse::<u32>().ok())
            .ok_or_else(|| format!("tham số '{k}' không phải Channel"))?;
        Ok(tauri::ipc::Channel::from_js(id, app))
    }

    fn ok_json<T: Serialize, E: std::fmt::Display>(r: Result<T, E>) -> Result<Value, String> {
        match r {
            Ok(v) => serde_json::to_value(v).map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn to_json<T: Serialize>(v: T) -> Result<Value, String> {
        serde_json::to_value(v).map_err(|e| e.to_string())
    }

    include!(concat!(env!("OUT_DIR"), "/dispatch.rs"));
}
