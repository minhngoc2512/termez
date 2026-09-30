//! Crate giả mang tên `tauri` cho bản Electron.
//!
//! Backend Termez (commands.rs, ssh.rs, sftp.rs, tunnel.rs, monitor.rs…) chỉ dùng
//! một phần rất nhỏ của Tauri: `AppHandle` (+ `emit`, `restart`), `State`,
//! `ipc::Channel` và thuộc tính `#[tauri::command]`. Crate này cài đúng phần đó,
//! chuyển sự kiện/output sang `Host` (do module napi cài, đẩy tiếp sang JS), nhờ
//! vậy backend biên dịch NGUYÊN VĂN, không phải sửa một dòng.

use std::ops::Deref;
use std::sync::Arc;

pub use termez_tauri_shim_macros::command;

#[derive(Debug)]
pub struct Error(pub String);
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Nơi nhận sự kiện / output của backend. Module napi cài trait này để đẩy sang JS.
pub trait Host: Send + Sync + 'static {
    /// Sự kiện toàn app (`app.emit`), payload đã JSON hoá.
    fn emit(&self, event: &str, payload_json: String);
    /// Một thông điệp của Channel `id` (thứ tự theo `index`, như Tauri Channel).
    fn channel(&self, id: u32, index: u64, body: ipc::InvokeResponseBody);
    /// Khởi động lại app.
    fn restart(&self);
}

#[derive(Clone)]
pub struct AppHandle {
    host: Arc<dyn Host>,
}

impl AppHandle {
    pub fn new(host: Arc<dyn Host>) -> Self {
        Self { host }
    }
    pub fn restart(&self) {
        self.host.restart();
    }
}

/// Giống `tauri::Emitter`: `app.emit("event", payload)`.
pub trait Emitter {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<()>;
}

impl Emitter for AppHandle {
    fn emit<S: serde::Serialize + Clone>(&self, event: &str, payload: S) -> Result<()> {
        let json = serde_json::to_string(&payload).map_err(|e| Error(e.to_string()))?;
        self.host.emit(event, json);
        Ok(())
    }
}

/// Giống `tauri::State`: tham chiếu tới state dùng chung, deref ra `T`.
pub struct State<'r, T: Send + Sync + 'static>(&'r T);

impl<'r, T: Send + Sync + 'static> State<'r, T> {
    pub fn new(inner: &'r T) -> Self {
        Self(inner)
    }
    pub fn inner(&self) -> &'r T {
        self.0
    }
}
impl<T: Send + Sync + 'static> Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}
impl<T: Send + Sync + 'static> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T: Send + Sync + 'static> Copy for State<'_, T> {}

pub mod ipc {
    use super::{AppHandle, Host, Result};
    use std::marker::PhantomData;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    pub enum InvokeResponseBody {
        Json(String),
        Raw(Vec<u8>),
    }

    /// Giống `tauri::ipc::Channel`: phía JS tạo Channel, gửi id qua lệnh; Rust
    /// `send` từng thông điệp, đánh số thứ tự để JS sắp lại cho đúng.
    pub struct Channel<TSend = InvokeResponseBody> {
        id: u32,
        next: Arc<AtomicU64>,
        host: Arc<dyn Host>,
        _p: PhantomData<fn(TSend)>,
    }

    impl<TSend> Clone for Channel<TSend> {
        fn clone(&self) -> Self {
            Self { id: self.id, next: self.next.clone(), host: self.host.clone(), _p: PhantomData }
        }
    }

    impl<TSend> Channel<TSend> {
        /// Dựng từ id mà JS gửi lên (chuỗi "__CHANNEL__:<id>").
        pub fn from_js(id: u32, app: &AppHandle) -> Self {
            Self { id, next: Arc::new(AtomicU64::new(0)), host: app.host.clone(), _p: PhantomData }
        }
        pub fn id(&self) -> u32 {
            self.id
        }
    }

    impl Channel<InvokeResponseBody> {
        pub fn send(&self, data: InvokeResponseBody) -> Result<()> {
            let index = self.next.fetch_add(1, Ordering::Relaxed);
            self.host.channel(self.id, index, data);
            Ok(())
        }
    }
}
