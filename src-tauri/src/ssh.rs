use crate::conn::{connect_authenticated, AuthMethod, JumpConfig, ProxyConfig};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration, MissedTickBehavior};

/// Gom output terminal rồi mới đẩy lên frontend: chờ tối đa OUT_FLUSH_DELAY kể từ
/// byte đầu tiên, hoặc đẩy ngay khi đủ OUT_FLUSH_BYTES. Vim cuộn trang sinh ra rất
/// nhiều gói nhỏ — gộp lại giúp giảm số lần IPC và số lần xterm vẽ lại.
const OUT_FLUSH_DELAY: Duration = Duration::from_millis(4);
const OUT_FLUSH_BYTES: usize = 64 * 1024;

/// Lệnh gửi vào task sở hữu SSH channel.
enum SshInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: String,
    /// true = shell tự kết thúc (user gõ `exit`, hoặc ta chủ động đóng) → không reconnect.
    /// false = kênh đứt ngang (mất mạng…) → frontend thử kết nối lại.
    clean: bool,
}

#[derive(Clone, Serialize)]
struct LatencyPayload {
    id: String,
    /// round-trip time (ms) đo bằng SSH keepalive ping.
    ms: u32,
}

/// Quản lý toàn bộ phiên SSH đang mở; mỗi phiên là 1 tokio task + kênh mpsc để điều khiển.
#[derive(Default)]
pub struct SshManager {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<SshInput>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kết nối tới host, mở PTY + shell, spawn task streaming. Trả về `session_id`.
    pub async fn connect(
        &self,
        app: AppHandle,
        // Kênh riêng của phiên này: output đi thẳng tới đúng pane, dạng byte thô.
        on_data: Channel<InvokeResponseBody>,
        address: String,
        port: u16,
        username: String,
        auth: AuthMethod,
        cols: u32,
        rows: u32,
        startup: Option<String>,
        keepalive: bool,
        proxy: Option<ProxyConfig>,
        jump: Option<Box<JumpConfig>>,
        expected: Option<String>,
        strict: bool,
        proxy_command: Option<String>,
    ) -> anyhow::Result<String> {
        let conn = connect_authenticated(
            &address, port, &username, auth, keepalive, proxy, jump, expected, strict, proxy_command,
        )
        .await?;

        // --- Mở channel + PTY + shell ---
        let mut channel = conn.handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;

        // Startup snippet: tự chạy lệnh khi vừa vào shell.
        if let Some(s) = startup {
            let s = s.trim();
            if !s.is_empty() {
                let _ = channel.data_bytes(format!("{s}\n").into_bytes()).await;
            }
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let (tx, mut rx) = mpsc::unbounded_channel::<SshInput>();
        self.sessions.lock().await.insert(session_id.clone(), tx);

        let sid = session_id.clone();
        tokio::spawn(async move {
            // Giữ kết nối (handle + jump handles) sống suốt vòng đời phiên.
            let conn = Arc::new(conn);
            // Đo độ trễ (SSH keepalive ping) 2s/lần → emit "ssh:latency". Chạy ở task riêng:
            // nếu chờ ping ngay trong vòng lặp đọc, lúc output dồn dập bộ đệm channel đầy
            // khiến session của russh không xử lý được phản hồi ping → cả phiên bị tắc.
            let pinger = {
                let (conn, app, sid) = (conn.clone(), app.clone(), sid.clone());
                tokio::spawn(async move {
                    let mut ping_tick = interval(Duration::from_secs(2));
                    ping_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                    loop {
                        ping_tick.tick().await;
                        let t = Instant::now();
                        // Timeout 5s để không kẹt nếu kết nối nửa-chết.
                        if let Ok(Ok(())) =
                            tokio::time::timeout(Duration::from_secs(5), conn.handle.send_ping()).await
                        {
                            let ms = t.elapsed().as_millis().min(u32::MAX as u128) as u32;
                            let _ = app.emit("ssh:latency", LatencyPayload { id: sid.clone(), ms });
                        }
                    }
                })
                .abort_handle()
            };
            // "sạch" = server đóng kênh graceful (Eof/Close, hoặc có exit-status/signal)
            // hoặc ta chủ động đóng. Chỉ `None` (kênh biến mất mà KHÔNG có Close) mới là
            // đứt ngang (mất mạng) → frontend sẽ thử kết nối lại.
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
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                                out.extend_from_slice(&data);
                                if out.len() >= OUT_FLUSH_BYTES {
                                    flush_armed = false;
                                    flush_out(&on_data, &mut out);
                                } else if !flush_armed {
                                    flush_timer
                                        .as_mut()
                                        .reset(tokio::time::Instant::now() + OUT_FLUSH_DELAY);
                                    flush_armed = true;
                                }
                            }
                            Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::ExitSignal { .. }) => {
                                clean = true; // shell tự kết thúc (vd user gõ `exit`)
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                                clean = true; // server đóng kênh bình thường
                                break;
                            }
                            None => break, // kênh đứt mà không có Close → mất mạng
                            _ => {}
                        }
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(SshInput::Data(bytes)) => {
                                let _ = channel.data_bytes(bytes).await;
                            }
                            Some(SshInput::Resize { cols, rows }) => {
                                let _ = channel.window_change(cols, rows, 0, 0).await;
                            }
                            Some(SshInput::Close) | None => {
                                let _ = channel.eof().await;
                                clean = true; // ta chủ động đóng (release/disconnect)
                                break;
                            }
                        }
                    }
                }
            }
            pinger.abort();
            flush_out(&on_data, &mut out); // đẩy nốt phần còn lại trước khi báo đóng
            let _ = app.emit("ssh:closed", ClosedPayload { id: sid, clean });
        });

        Ok(session_id)
    }

    pub async fn send(&self, id: &str, data: Vec<u8>) -> anyhow::Result<()> {
        if let Some(tx) = self.sessions.lock().await.get(id) {
            tx.send(SshInput::Data(data))
                .map_err(|_| anyhow::anyhow!("phiên đã đóng"))?;
        }
        Ok(())
    }

    pub async fn resize(&self, id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        if let Some(tx) = self.sessions.lock().await.get(id) {
            let _ = tx.send(SshInput::Resize { cols, rows });
        }
        Ok(())
    }

    pub async fn disconnect(&self, id: &str) -> anyhow::Result<()> {
        if let Some(tx) = self.sessions.lock().await.remove(id) {
            let _ = tx.send(SshInput::Close);
        }
        Ok(())
    }
}

/// Đẩy phần output đã gom lên frontend (byte thô → ArrayBuffer bên JS).
fn flush_out(ch: &Channel<InvokeResponseBody>, out: &mut Vec<u8>) {
    if out.is_empty() {
        return;
    }
    let _ = ch.send(InvokeResponseBody::Raw(std::mem::take(out)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Host giả: đếm byte output, mô phỏng terminal xử lý chậm bằng cách ngủ mỗi gói.
    struct Counter {
        bytes: AtomicU64,
        delay: std::time::Duration,
    }
    impl tauri::Host for Counter {
        fn emit(&self, _: &str, _: String) {}
        fn channel(&self, _: u32, _: u64, body: InvokeResponseBody) {
            if let InvokeResponseBody::Raw(b) = body {
                self.bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
            }
            std::thread::sleep(self.delay);
        }
        fn restart(&self) {}
    }

    /// Output lớn không được làm tắc phiên, kể cả khi bên nhận chậm hơn tốc độ dữ liệu đến
    /// (phiên từng tắc hẳn ở lần ping đầu tiên): `TERMEZ_TEST_SSH=host:port:user:password`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    async fn large_output_does_not_stall() {
        let Ok(v) = std::env::var("TERMEZ_TEST_SSH") else { return };
        let p: Vec<&str> = v.splitn(4, ':').collect();
        for delay_ms in [0u64, 5, 60] {
            let c = Arc::new(Counter { bytes: AtomicU64::new(0), delay: Duration::from_millis(delay_ms) });
            let app = tauri::AppHandle::new(c.clone());
            let ch: Channel<InvokeResponseBody> = Channel::from_js(1, &app);
            let m = SshManager::new();
            let t0 = Instant::now();
            let id = m
                .connect(
                    app.clone(),
                    ch,
                    p[0].into(),
                    p[1].parse().unwrap(),
                    p[2].into(),
                    AuthMethod::Password(p[3].into()),
                    80,
                    24,
                    Some("seq 1 400000".into()),
                    false,
                    None,
                    None,
                    None,
                    false,
                    None,
                )
                .await
                .expect("connect");
            let (mut last, mut idle) = (0, 0);
            // seq 1..400000 ≈ 2,7 MB (kèm \r).
            while c.bytes.load(Ordering::Relaxed) < 2_700_000 && idle < 12 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let now = c.bytes.load(Ordering::Relaxed);
                eprintln!("delay={delay_ms}ms t={:?} bytes={now}", t0.elapsed());
                idle = if now == last { idle + 1 } else { 0 };
                last = now;
            }
            let _ = m.disconnect(&id).await;
            assert!(c.bytes.load(Ordering::Relaxed) >= 2_700_000, "phiên bị tắc ở {last} byte (delay {delay_ms} ms)");
        }
    }
}
