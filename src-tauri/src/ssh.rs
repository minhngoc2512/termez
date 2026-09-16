use crate::conn::{connect_authenticated, AuthMethod, JumpConfig, ProxyConfig};
use base64::Engine;
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

/// Lệnh gửi vào task sở hữu SSH channel.
enum SshInput {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: String,
    /// dữ liệu terminal, base64 để giữ nguyên byte
    data: String,
}

#[derive(Clone, Serialize)]
struct ClosedPayload {
    id: String,
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
    ) -> anyhow::Result<String> {
        let conn = connect_authenticated(
            &address, port, &username, auth, keepalive, proxy, jump, expected, strict,
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
            let _conn = conn;
            loop {
                tokio::select! {
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => emit_data(&app, &sid, &data),
                            Some(ChannelMsg::ExtendedData { data, .. }) => emit_data(&app, &sid, &data),
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
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
                                break;
                            }
                        }
                    }
                }
            }
            let _ = app.emit("ssh:closed", ClosedPayload { id: sid });
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

fn emit_data(app: &AppHandle, id: &str, data: &[u8]) {
    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
    let _ = app.emit(
        "ssh:data",
        DataPayload {
            id: id.to_string(),
            data: encoded,
        },
    );
}
