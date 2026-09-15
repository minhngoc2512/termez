//! SFTP: duyệt & thao tác file trên endpoint (Local hoặc server), và transfer
//! đa hướng (Local↔Server, Server↔Server relay qua máy) với tiến trình.

use crate::conn::{connect_authenticated, AuthMethod, Connection, JumpConfig, ProxyConfig};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

pub const LOCAL: &str = "local";

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// mtime unix seconds (nếu có)
    pub modified: Option<u64>,
}

#[derive(Clone, Serialize)]
struct Progress {
    id: String,
    transferred: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct TransferDone {
    id: String,
}

#[derive(Clone, Serialize)]
struct TransferError {
    id: String,
    error: String,
}

struct SftpConn {
    _conn: Connection,
    session: SftpSession,
}

#[derive(Default)]
pub struct SftpManager {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mở (nếu chưa có) SFTP session tới server. Trả về thư mục home (canonicalize ".").
    pub async fn ensure_open(
        &self,
        host_id: &str,
        address: &str,
        port: u16,
        username: &str,
        auth: AuthMethod,
        proxy: Option<ProxyConfig>,
        jump: Option<Box<JumpConfig>>,
    ) -> anyhow::Result<String> {
        if let Some(c) = self.conns.lock().await.get(host_id) {
            return Ok(c.session.canonicalize(".").await.unwrap_or_else(|_| "/".into()));
        }
        let conn = connect_authenticated(address, port, username, auth, true, proxy, jump).await?;
        let channel = conn.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = SftpSession::new(channel.into_stream()).await?;
        let home = session.canonicalize(".").await.unwrap_or_else(|_| "/".into());
        self.conns
            .lock()
            .await
            .insert(host_id.to_string(), Arc::new(SftpConn { _conn: conn, session }));
        Ok(home)
    }

    pub async fn close(&self, host_id: &str) {
        self.conns.lock().await.remove(host_id);
    }

    async fn conn(&self, host_id: &str) -> anyhow::Result<Arc<SftpConn>> {
        self.conns
            .lock()
            .await
            .get(host_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("chưa mở SFTP cho endpoint này"))
    }

    // ----- Duyệt & thao tác -----

    pub async fn list(&self, endpoint: &str, path: &str) -> anyhow::Result<Vec<FileEntry>> {
        if endpoint == LOCAL {
            list_local(path).await
        } else {
            let c = self.conn(endpoint).await?;
            let mut out = Vec::new();
            for entry in c.session.read_dir(path).await? {
                let md = entry.metadata();
                out.push(FileEntry {
                    name: entry.file_name(),
                    is_dir: md.is_dir(),
                    size: md.size.unwrap_or(0),
                    modified: md.mtime.map(|t| t as u64),
                });
            }
            Ok(out)
        }
    }

    pub async fn home(&self, endpoint: &str) -> anyhow::Result<String> {
        if endpoint == LOCAL {
            Ok(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
        } else {
            let c = self.conn(endpoint).await?;
            Ok(c.session.canonicalize(".").await.unwrap_or_else(|_| "/".into()))
        }
    }

    pub async fn mkdir(&self, endpoint: &str, path: &str) -> anyhow::Result<()> {
        if endpoint == LOCAL {
            tokio::fs::create_dir(path).await?;
        } else {
            self.conn(endpoint).await?.session.create_dir(path).await?;
        }
        Ok(())
    }

    pub async fn rename(&self, endpoint: &str, from: &str, to: &str) -> anyhow::Result<()> {
        if endpoint == LOCAL {
            tokio::fs::rename(from, to).await?;
        } else {
            self.conn(endpoint).await?.session.rename(from, to).await?;
        }
        Ok(())
    }

    pub async fn remove(&self, endpoint: &str, path: &str, is_dir: bool) -> anyhow::Result<()> {
        if endpoint == LOCAL {
            if is_dir {
                tokio::fs::remove_dir_all(path).await?;
            } else {
                tokio::fs::remove_file(path).await?;
            }
        } else {
            let c = self.conn(endpoint).await?;
            if is_dir {
                c.session.remove_dir(path).await?;
            } else {
                c.session.remove_file(path).await?;
            }
        }
        Ok(())
    }

    // ----- Transfer -----

    async fn open_reader(
        &self,
        endpoint: &str,
        path: &str,
    ) -> anyhow::Result<(Box<dyn AsyncRead + Unpin + Send>, u64)> {
        if endpoint == LOCAL {
            let f = tokio::fs::File::open(path).await?;
            let total = f.metadata().await.map(|m| m.len()).unwrap_or(0);
            Ok((Box::new(f), total))
        } else {
            let c = self.conn(endpoint).await?;
            let total = c.session.metadata(path).await.map(|m| m.size.unwrap_or(0)).unwrap_or(0);
            let f = c.session.open(path).await?;
            Ok((Box::new(f), total))
        }
    }

    async fn open_writer(
        &self,
        endpoint: &str,
        path: &str,
    ) -> anyhow::Result<Box<dyn AsyncWrite + Unpin + Send>> {
        if endpoint == LOCAL {
            Ok(Box::new(tokio::fs::File::create(path).await?))
        } else {
            let c = self.conn(endpoint).await?;
            Ok(Box::new(c.session.create(path).await?))
        }
    }

    /// Copy 1 file giữa 2 endpoint theo chunk, phát tiến trình. Chạy nền.
    pub fn spawn_transfer(
        self: Arc<Self>,
        app: AppHandle,
        job_id: String,
        src_ep: String,
        src_path: String,
        dst_ep: String,
        dst_path: String,
    ) {
        tokio::spawn(async move {
            if let Err(e) = self
                .do_transfer(&app, &job_id, &src_ep, &src_path, &dst_ep, &dst_path)
                .await
            {
                let _ = app.emit(
                    "sftp:transfer-error",
                    TransferError { id: job_id.clone(), error: e.to_string() },
                );
            } else {
                let _ = app.emit("sftp:transfer-done", TransferDone { id: job_id.clone() });
            }
        });
    }

    async fn do_transfer(
        &self,
        app: &AppHandle,
        job_id: &str,
        src_ep: &str,
        src_path: &str,
        dst_ep: &str,
        dst_path: &str,
    ) -> anyhow::Result<()> {
        let (mut reader, total) = self.open_reader(src_ep, src_path).await?;
        let mut writer = self.open_writer(dst_ep, dst_path).await?;

        let mut buf = vec![0u8; 64 * 1024];
        let mut transferred: u64 = 0;
        let mut last = Instant::now();
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n]).await?;
            transferred += n as u64;
            if last.elapsed().as_millis() >= 100 {
                let _ = app.emit(
                    "sftp:progress",
                    Progress { id: job_id.to_string(), transferred, total },
                );
                last = Instant::now();
            }
        }
        writer.flush().await?;
        writer.shutdown().await.ok();
        let _ = app.emit(
            "sftp:progress",
            Progress { id: job_id.to_string(), transferred, total },
        );
        Ok(())
    }
}

async fn list_local(path: &str) -> anyhow::Result<Vec<FileEntry>> {
    let mut out = Vec::new();
    let mut rd = tokio::fs::read_dir(path).await?;
    while let Some(entry) = rd.next_entry().await? {
        let md = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        out.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: md.is_dir(),
            size: md.len(),
            modified,
        });
    }
    Ok(out)
}
