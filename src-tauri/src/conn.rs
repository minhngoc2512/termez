//! Kết nối SSH đã xác thực, dùng chung cho terminal (ssh.rs), SFTP (sftp.rs) và tunnel.
//! Hỗ trợ keepalive, proxy (SOCKS5 / HTTP CONNECT), và jump host (ProxyJump nhiều tầng).

use async_http_proxy::{http_connect_tokio, http_connect_tokio_with_basic_auth};
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_socks::tcp::Socks5Stream;

/// Phương thức xác thực đã resolve (secret lấy từ keychain ở tầng command).
#[derive(Clone)]
pub enum AuthMethod {
    Password(String),
    Key {
        pem: String,
        passphrase: Option<String>,
    },
}

/// Cấu hình proxy (secret lấy từ keychain).
#[derive(Clone)]
pub struct ProxyConfig {
    /// "socks5" | "http"
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Một chặng jump host (bastion). Có thể lồng nhau cho ProxyJump nhiều tầng.
#[derive(Clone)]
pub struct JumpConfig {
    pub address: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub proxy: Option<ProxyConfig>,
    pub jump: Option<Box<JumpConfig>>,
}

/// Kết nối SSH: handle của server đích + các handle jump giữ cho sống.
pub struct Connection {
    pub handle: Handle<ClientHandler>,
    /// Giữ các handle jump host sống suốt vòng đời kết nối (không được drop sớm).
    _keep: Vec<Handle<ClientHandler>>,
}

/// Handler SSH client. Phase hiện tại chấp nhận mọi server key (TODO: known_hosts).
pub struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Tạo TCP stream tới server, trực tiếp hoặc qua proxy. Cả 3 nhánh đều cho ra TcpStream.
async fn open_stream(
    address: &str,
    port: u16,
    proxy: &Option<ProxyConfig>,
) -> anyhow::Result<TcpStream> {
    match proxy {
        None => Ok(TcpStream::connect((address, port)).await?),
        Some(p) if p.kind == "socks5" => {
            let proxy_addr = (p.host.as_str(), p.port);
            let target = (address, port);
            let s = match (&p.username, &p.password) {
                (Some(u), Some(pw)) => {
                    Socks5Stream::connect_with_password(proxy_addr, target, u, pw).await?
                }
                _ => Socks5Stream::connect(proxy_addr, target).await?,
            };
            Ok(s.into_inner())
        }
        Some(p) => {
            let mut s = TcpStream::connect((p.host.as_str(), p.port)).await?;
            match (&p.username, &p.password) {
                (Some(u), Some(pw)) => {
                    http_connect_tokio_with_basic_auth(&mut s, address, port, u, pw).await?
                }
                _ => http_connect_tokio(&mut s, address, port).await?,
            }
            Ok(s)
        }
    }
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    username: &str,
    auth: AuthMethod,
) -> anyhow::Result<()> {
    let ok = match auth {
        AuthMethod::Password(pw) => handle.authenticate_password(username, pw).await?.success(),
        AuthMethod::Key { pem, passphrase } => {
            let key = decode_secret_key(&pem, passphrase.as_deref())
                .map_err(|e| anyhow::anyhow!("đọc private key lỗi: {e}"))?;
            let hash = if key.algorithm().is_rsa() {
                Some(HashAlg::Sha256)
            } else {
                None
            };
            let pkwha = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
            handle.authenticate_publickey(username, pkwha).await?.success()
        }
    };
    if !ok {
        return Err(anyhow::anyhow!("Xác thực thất bại (sai thông tin đăng nhập?)"));
    }
    Ok(())
}

/// Mở kết nối SSH (qua proxy và/hoặc jump host nếu có) và xác thực.
pub async fn connect_authenticated(
    address: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    keepalive: bool,
    proxy: Option<ProxyConfig>,
    jump: Option<Box<JumpConfig>>,
) -> anyhow::Result<Connection> {
    let mut cfg = client::Config::default();
    if keepalive {
        cfg.keepalive_interval = Some(Duration::from_secs(30));
        cfg.keepalive_max = 3;
    }
    let config = Arc::new(cfg);

    let mut keep: Vec<Handle<ClientHandler>> = Vec::new();

    let mut handle = match jump {
        None => {
            let stream = open_stream(address, port, &proxy).await?;
            client::connect_stream(config, stream, ClientHandler).await?
        }
        Some(j) => {
            // Kết nối tới jump host trước (đệ quy — jump có thể có jump/proxy riêng).
            let jump_conn = Box::pin(connect_authenticated(
                &j.address,
                j.port,
                &j.username,
                j.auth.clone(),
                false,
                j.proxy.clone(),
                j.jump.clone(),
            ))
            .await?;
            // Mở kênh direct-tcpip từ jump host tới server đích, dùng làm transport.
            let channel = jump_conn
                .handle
                .channel_open_direct_tcpip(address, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| anyhow::anyhow!("mở kênh qua jump host lỗi: {e}"))?;
            keep.push(jump_conn.handle);
            keep.extend(jump_conn._keep);
            client::connect_stream(config, channel.into_stream(), ClientHandler).await?
        }
    };

    authenticate(&mut handle, username, auth).await?;
    Ok(Connection { handle, _keep: keep })
}
