//! Kết nối SSH đã xác thực, dùng chung cho terminal (ssh.rs), SFTP (sftp.rs) và tunnel.
//! Hỗ trợ keepalive, proxy (SOCKS5 / HTTP CONNECT), và jump host (ProxyJump nhiều tầng).

use async_http_proxy::{http_connect_tokio, http_connect_tokio_with_basic_auth};
use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_socks::tcp::Socks5Stream;

/// Khóa server nhìn thấy khi bắt tay (để hiển thị / lưu known_hosts).
#[derive(Clone, Default)]
pub struct SeenKey {
    pub key_openssh: String,
    pub fingerprint: String,
    pub algorithm: String,
}

/// Chính sách kiểm tra host key cho một kết nối.
#[derive(Clone)]
pub struct HostKeyCheck {
    /// Fingerprint (SHA256:...) đã lưu, hoặc None nếu chưa biết host.
    pub expected: Option<String>,
    /// true: host lạ → TỪ CHỐI (TOFU cho terminal). false: chấp nhận host lạ (sftp/tunnel).
    pub strict: bool,
    /// Ghi lại khóa server thực tế để tầng trên đọc khi từ chối.
    pub seen: Arc<Mutex<Option<SeenKey>>>,
}

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

/// Handler SSH client: kiểm tra host key theo `verify`.
pub struct ClientHandler {
    pub verify: HostKeyCheck,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pk = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            // Chứng chỉ SSH: tạm chấp nhận (hiếm gặp).
            PublicKeyOrCertificate::Certificate(_) => return Ok(true),
        };
        let key_openssh = pk.to_openssh().unwrap_or_default();
        let fingerprint = pk.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = pk.algorithm().to_string();
        *self.verify.seen.lock().unwrap() = Some(SeenKey {
            key_openssh,
            fingerprint: fingerprint.clone(),
            algorithm,
        });
        Ok(match &self.verify.expected {
            Some(e) => e == &fingerprint,
            None => !self.verify.strict,
        })
    }
}

/// Kết nối stream + kiểm tra host key; nếu bị từ chối, dựng lỗi "HOSTKEY\t..." mang khóa thấy được.
async fn connect_checked<R>(
    config: Arc<client::Config>,
    stream: R,
    verify: HostKeyCheck,
    had_expected: bool,
) -> anyhow::Result<Handle<ClientHandler>>
where
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let seen = verify.seen.clone();
    match client::connect_stream(config, stream, ClientHandler { verify }).await {
        Ok(h) => Ok(h),
        Err(err) => {
            if let Some(k) = seen.lock().unwrap().take() {
                let kind = if had_expected { "changed" } else { "unknown" };
                anyhow::bail!("HOSTKEY\t{kind}\t{}\t{}\t{}", k.algorithm, k.fingerprint, k.key_openssh);
            }
            Err(err.into())
        }
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
#[allow(clippy::too_many_arguments)]
pub async fn connect_authenticated(
    address: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    keepalive: bool,
    proxy: Option<ProxyConfig>,
    jump: Option<Box<JumpConfig>>,
    expected: Option<String>,
    strict: bool,
) -> anyhow::Result<Connection> {
    let mut cfg = client::Config::default();
    if keepalive {
        cfg.keepalive_interval = Some(Duration::from_secs(30));
        cfg.keepalive_max = 3;
    }
    let config = Arc::new(cfg);

    let mut keep: Vec<Handle<ClientHandler>> = Vec::new();
    let had_expected = expected.is_some();
    let verify = HostKeyCheck {
        expected,
        strict,
        seen: Arc::new(Mutex::new(None)),
    };

    let mut handle = match jump {
        None => {
            let stream = open_stream(address, port, &proxy).await?;
            connect_checked(config, stream, verify, had_expected).await?
        }
        Some(j) => {
            // Kết nối jump host trước (đệ quy). Jump: chấp nhận host lạ (chưa verify jump).
            let jump_conn = Box::pin(connect_authenticated(
                &j.address,
                j.port,
                &j.username,
                j.auth.clone(),
                false,
                j.proxy.clone(),
                j.jump.clone(),
                None,
                false,
            ))
            .await?;
            let channel = jump_conn
                .handle
                .channel_open_direct_tcpip(address, port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| anyhow::anyhow!("mở kênh qua jump host lỗi: {e}"))?;
            keep.push(jump_conn.handle);
            keep.extend(jump_conn._keep);
            connect_checked(config, channel.into_stream(), verify, had_expected).await?
        }
    };

    authenticate(&mut handle, username, auth).await?;
    Ok(Connection { handle, _keep: keep })
}
