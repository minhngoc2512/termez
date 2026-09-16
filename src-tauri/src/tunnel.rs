//! Port forwarding: Local (-L) và Dynamic/SOCKS5 (-D) qua kênh direct-tcpip của SSH.
//! (Remote -R sẽ bổ sung sau — cần callback nhận kênh từ server.)

use crate::conn::{connect_authenticated, AuthMethod, Connection, JumpConfig, ProxyConfig};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{copy_bidirectional, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

/// Thông số để mở một tunnel (thông tin kết nối host đã resolve từ keychain).
pub struct TunnelSpec {
    pub kind: String, // "local" | "dynamic"
    pub local_port: u16,
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub proxy: Option<ProxyConfig>,
    pub jump: Option<Box<JumpConfig>>,
    pub expected_hostkey: Option<String>,
}

#[derive(Clone, Serialize)]
struct TunnelStatus {
    id: String,
    active: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct TunnelManager {
    active: Mutex<HashMap<String, AbortHandle>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn active_ids(&self) -> Vec<String> {
        self.active.lock().await.keys().cloned().collect()
    }

    pub async fn stop(&self, id: &str, app: &AppHandle) {
        if let Some(a) = self.active.lock().await.remove(id) {
            a.abort();
        }
        let _ = app.emit(
            "tunnel:status",
            TunnelStatus { id: id.to_string(), active: false, error: None },
        );
    }

    pub async fn start(&self, app: AppHandle, id: String, spec: TunnelSpec) -> anyhow::Result<()> {
        if self.active.lock().await.contains_key(&id) {
            return Ok(());
        }
        // Kết nối SSH tới host (giữ keepalive). Arc để chia sẻ cho từng kết nối con.
        let conn = Arc::new(
            connect_authenticated(
                &spec.address,
                spec.port,
                &spec.username,
                spec.auth,
                true,
                spec.proxy,
                spec.jump,
                spec.expected_hostkey,
                false,
            )
            .await?,
        );

        // Lắng nghe cổng local.
        let listener = TcpListener::bind(("127.0.0.1", spec.local_port))
            .await
            .map_err(|e| anyhow::anyhow!("không bind được cổng {}: {e}", spec.local_port))?;

        let kind = spec.kind.clone();
        let rhost = spec.remote_host.clone();
        let rport = spec.remote_port;

        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((sock, _peer)) => {
                        let conn = conn.clone();
                        let kind = kind.clone();
                        let rhost = rhost.clone();
                        tokio::spawn(async move {
                            let _ = handle_conn(conn, &kind, rhost, rport, sock).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });

        self.active.lock().await.insert(id.clone(), task.abort_handle());
        let _ = app.emit("tunnel:status", TunnelStatus { id, active: true, error: None });
        Ok(())
    }
}

async fn handle_conn(
    conn: Arc<Connection>,
    kind: &str,
    rhost: Option<String>,
    rport: Option<u16>,
    mut sock: TcpStream,
) -> anyhow::Result<()> {
    let (thost, tport) = if kind == "dynamic" {
        socks5_handshake(&mut sock).await?
    } else {
        (
            rhost.unwrap_or_else(|| "127.0.0.1".into()),
            rport.unwrap_or(0),
        )
    };

    let channel = conn
        .handle
        .channel_open_direct_tcpip(thost, tport as u32, "127.0.0.1", 0)
        .await?;
    let mut stream = channel.into_stream();
    let _ = copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

/// SOCKS5 handshake tối giản (no-auth, CONNECT). Trả về (host, port) đích.
async fn socks5_handshake(sock: &mut TcpStream) -> anyhow::Result<(String, u16)> {
    // Greeting: VER, NMETHODS, METHODS...
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        anyhow::bail!("không phải SOCKS5");
    }
    let n = head[1] as usize;
    let mut methods = vec![0u8; n];
    sock.read_exact(&mut methods).await?;
    // Chọn method 0x00 (no auth).
    sock.write_all(&[0x05, 0x00]).await?;

    // Request: VER, CMD, RSV, ATYP
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[1] != 0x01 {
        // chỉ hỗ trợ CONNECT
        sock.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
        anyhow::bail!("SOCKS5 command không hỗ trợ");
    }
    let host = match req[3] {
        0x01 => {
            let mut b = [0u8; 4];
            sock.read_exact(&mut b).await?;
            format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
        }
        0x03 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut d = vec![0u8; len[0] as usize];
            sock.read_exact(&mut d).await?;
            String::from_utf8_lossy(&d).to_string()
        }
        0x04 => {
            let mut b = [0u8; 16];
            sock.read_exact(&mut b).await?;
            let seg: Vec<String> = b.chunks(2).map(|c| format!("{:x}", u16::from_be_bytes([c[0], c[1]]))).collect();
            seg.join(":")
        }
        _ => anyhow::bail!("ATYP không hỗ trợ"),
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);

    // Reply thành công (BND.ADDR = 0.0.0.0:0).
    sock.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    Ok((host, port))
}
