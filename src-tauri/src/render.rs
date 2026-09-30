//! Tuỳ chọn tăng tốc GPU (DMABUF) của WebKitGTK trên Linux.
//!
//! Mặc định TẮT DMABUF: trên một số GPU/driver nó làm màn hình đen. Người dùng có
//! thể bật lại để vẽ mượt hơn, nhưng bật theo kiểu "thử rồi xác nhận":
//! - Bật → ghi cờ "trial". Lần mở kế tiếp chạy với DMABUF, và NGAY lúc khởi động
//!   cờ bị đặt lại về "off".
//! - App hỏi "màn hình có bình thường không?"; chỉ khi bấm Giữ mới ghi "on".
//! Nhờ vậy nếu màn hình đen, chỉ cần đóng rồi mở lại app là về chế độ an toàn.
//!
//! Cờ phải đọc TRƯỚC khi WebView khởi tạo nên lưu trong file ở thư mục dữ liệu app
//! (trùng `app_data_dir` của Tauri), không dùng localStorage được.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static DMABUF_ON: AtomicBool = AtomicBool::new(false);
static TRIAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static ENV_FORCED: AtomicBool = AtomicBool::new(false);

const ENV_KEY: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// $XDG_DATA_HOME/com.termez.app/gpu-dmabuf (mặc định ~/.local/share/…).
fn flag_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))?;
    Some(base.join("com.termez.app").join("gpu-dmabuf"))
}

fn read_mode() -> String {
    flag_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn write_mode(mode: &str) -> Result<(), String> {
    let p = flag_path().ok_or("Không xác định được thư mục dữ liệu")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, mode).map_err(|e| e.to_string())
}

/// Gọi ở đầu `run()`, TRƯỚC khi WebView khởi tạo.
pub fn apply_at_startup() {
    if !cfg!(target_os = "linux") {
        return;
    }
    // User tự đặt biến môi trường → tôn trọng, không đụng tới.
    if let Some(v) = std::env::var_os(ENV_KEY) {
        ENV_FORCED.store(true, Ordering::Relaxed);
        DMABUF_ON.store(v != "1", Ordering::Relaxed);
        return;
    }
    match read_mode().as_str() {
        "on" => DMABUF_ON.store(true, Ordering::Relaxed),
        "trial" => {
            DMABUF_ON.store(true, Ordering::Relaxed);
            TRIAL_ACTIVE.store(true, Ordering::Relaxed);
            let _ = write_mode("off"); // lần sau về an toàn, trừ khi user bấm Giữ
        }
        _ => std::env::set_var(ENV_KEY, "1"),
    }
}

#[derive(Serialize)]
pub struct RenderStatus {
    /// Chỉ Linux mới có tuỳ chọn này.
    supported: bool,
    /// DMABUF đang bật ở phiên chạy hiện tại.
    dmabuf: bool,
    /// Đang chạy thử (cần xác nhận Giữ).
    trial: bool,
    /// Bị biến môi trường WEBKIT_DISABLE_DMABUF_RENDERER ghi đè.
    env_forced: bool,
}

#[tauri::command]
pub fn render_status() -> RenderStatus {
    RenderStatus {
        supported: cfg!(target_os = "linux"),
        dmabuf: DMABUF_ON.load(Ordering::Relaxed),
        trial: TRIAL_ACTIVE.load(Ordering::Relaxed),
        env_forced: ENV_FORCED.load(Ordering::Relaxed),
    }
}

/// Bật → ghi "trial" (áp dụng từ lần mở sau). Tắt → ghi "off".
#[tauri::command]
pub fn render_set_dmabuf(enabled: bool) -> Result<(), String> {
    write_mode(if enabled { "trial" } else { "off" })
}

/// Người dùng xác nhận màn hình hiển thị bình thường → giữ DMABUF.
#[tauri::command]
pub fn render_confirm_dmabuf() -> Result<(), String> {
    write_mode("on")?;
    TRIAL_ACTIVE.store(false, Ordering::Relaxed);
    Ok(())
}
