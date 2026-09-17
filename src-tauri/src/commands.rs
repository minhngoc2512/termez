use crate::conn::{AuthMethod, JumpConfig, ProxyConfig};
use crate::db::{self, Group, Host, HostInput, SshKey, Tunnel, TunnelInput, VaultEntry, VaultEntryInput};
use crate::keychain;
use crate::keys;
use crate::sftp::{FileEntry, SftpManager};
use crate::ssh::SshManager;
use crate::sync;
use crate::tunnel::{TunnelManager, TunnelSpec};
use base64::Engine;
use sqlx::SqlitePool;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// State toàn cục của app: DB pool + phiên SSH + phiên SFTP + tunnel.
pub struct AppState {
    pub db: SqlitePool,
    pub ssh: SshManager,
    pub sftp: Arc<SftpManager>,
    pub tunnels: Arc<TunnelManager>,
    /// debounce handle cho auto-sync
    pub autosync: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
    /// Có thay đổi cục bộ chưa đẩy lên remote (để phát hiện conflict).
    pub dirty: Arc<std::sync::atomic::AtomicBool>,
    pub monitor: Arc<crate::monitor::MonitorManager>,
}

/// Dựng chuỗi jump host từ `jump_host_id` (đệ quy, có chặn vòng lặp).
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

/// Dựng AuthMethod từ host (lấy secret từ keychain). Dùng cho cả terminal & SFTP.
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
                // Passphrase cho key file (nếu có) lấy từ ô password đã lưu.
                let passphrase = keychain::get_secret(&keychain::host_password(&host.id)).map_err(e)?;
                Ok(AuthMethod::Key { pem, passphrase })
            } else {
                Err("Host dùng key nhưng chưa chọn key".into())
            }
        }
        other => Err(format!("auth_type '{other}' chưa hỗ trợ")),
    }
}

/// Dựng ProxyConfig từ host (mật khẩu proxy lấy từ keychain).
fn resolve_proxy(host: &Host) -> R<Option<ProxyConfig>> {
    match host.proxy_type.as_deref() {
        Some(kind) if !kind.is_empty() && kind != "none" => {
            let phost = host
                .proxy_host
                .clone()
                .ok_or_else(|| "Proxy thiếu địa chỉ".to_string())?;
            let port = host.proxy_port.unwrap_or(1080) as u16;
            let password = keychain::get_secret(&keychain::proxy_password(&host.id)).map_err(e)?;
            Ok(Some(ProxyConfig {
                kind: kind.to_string(),
                host: phost,
                port,
                username: host.proxy_username.clone(),
                password,
            }))
        }
        _ => Ok(None),
    }
}

type R<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs_home() {
            return format!("{home}/{rest}");
        }
    }
    path.to_string()
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok()
}

// ----- Groups -----

#[tauri::command]
pub async fn get_groups(state: State<'_, AppState>) -> R<Vec<Group>> {
    db::list_groups(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn create_group(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> R<Group> {
    let g = db::create_group(&state.db, &name, parent_id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(g)
}

#[tauri::command]
pub async fn delete_group(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    db::delete_group(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

// ----- Hosts -----

#[tauri::command]
pub async fn get_hosts(state: State<'_, AppState>) -> R<Vec<Host>> {
    db::list_hosts(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn upsert_host(app: AppHandle, state: State<'_, AppState>, mut input: HostInput) -> R<Host> {
    // Tách secret ra khỏi input để KHÔNG ghi plaintext vào SQLite.
    let password = input.password.take();
    let proxy_password = input.proxy_password.take();

    let host = db::upsert_host(&state.db, input).await.map_err(e)?;

    // Lưu mật khẩu vào keychain (chỉ khi có nhập; để trống khi sửa = giữ nguyên).
    // Lưu cho MỌI auth type: dùng làm mật khẩu đăng nhập, hoặc passphrase cho key file.
    if let Some(pw) = password {
        if !pw.is_empty() {
            keychain::set_secret(&keychain::host_password(&host.id), &pw).map_err(e)?;
        }
    }
    if let Some(pp) = proxy_password {
        if !pp.is_empty() {
            keychain::set_secret(&keychain::proxy_password(&host.id), &pp).map_err(e)?;
        }
    }
    schedule_autosync(app, &state);
    Ok(host)
}

/// Resolve auth/proxy/jump/hostkey rồi mở kết nối SSH tới host (dùng cho monitor).
async fn resolve_connect(db: &SqlitePool, host: &Host, strict: bool) -> R<crate::conn::Connection> {
    let auth = resolve_auth(host)?;
    let proxy = resolve_proxy(host)?;
    let jump = resolve_jump(db, host, 0).await?;
    let expected = db::get_known_host(db, &host.address, host.port as u16)
        .await
        .map_err(e)?
        .map(|k| k.fingerprint);
    crate::conn::connect_authenticated(
        &host.address,
        host.port as u16,
        &host.username,
        auth,
        true,
        proxy,
        jump,
        expected,
        strict,
        host.proxy_command.clone(),
    )
    .await
    .map_err(|err| {
        if err.to_string().starts_with("HOSTKEY\t") {
            "Host key changed — open a terminal to this host to verify it.".to_string()
        } else {
            err.to_string()
        }
    })
}

#[tauri::command]
pub async fn monitor_start(app: AppHandle, state: State<'_, AppState>, host_id: String) -> R<()> {
    let host = db::get_host(&state.db, &host_id).await.map_err(e)?;
    let conn = resolve_connect(&state.db, &host, false).await?;
    state.monitor.start(app, host_id, Arc::new(conn)).await;
    Ok(())
}

#[tauri::command]
pub async fn monitor_stop(state: State<'_, AppState>, host_id: String) -> R<()> {
    state.monitor.stop(&host_id).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_host(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    keychain::delete_secret(&keychain::host_password(&id)).ok();
    keychain::delete_secret(&keychain::proxy_password(&id)).ok();
    db::delete_host(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

struct SshBlock {
    alias: String,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<i64>,
    identity_file: Option<String>,
    proxy_command: Option<String>,
}

fn parse_ssh_config(content: &str) -> Vec<SshBlock> {
    let mut out = Vec::new();
    let mut cur: Option<SshBlock> = None;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, val)) = line.split_once(char::is_whitespace) else { continue };
        let val = val.trim().trim_start_matches('=').trim();
        match key.to_lowercase().as_str() {
            "host" => {
                if let Some(b) = cur.take() {
                    if !b.alias.is_empty() {
                        out.push(b);
                    }
                }
                let alias = val
                    .split_whitespace()
                    .find(|p| !p.contains('*') && !p.contains('?'))
                    .unwrap_or("")
                    .to_string();
                cur = Some(SshBlock {
                    alias,
                    hostname: None,
                    user: None,
                    port: None,
                    identity_file: None,
                    proxy_command: None,
                });
            }
            other => {
                if let Some(b) = cur.as_mut() {
                    match other {
                        "hostname" => b.hostname = Some(val.to_string()),
                        "user" => b.user = Some(val.to_string()),
                        "port" => b.port = val.parse().ok(),
                        "identityfile" => b.identity_file = Some(val.to_string()),
                        "proxycommand" => b.proxy_command = Some(val.to_string()),
                        _ => {}
                    }
                }
            }
        }
    }
    if let Some(b) = cur.take() {
        if !b.alias.is_empty() {
            out.push(b);
        }
    }
    out.into_iter().filter(|b| !b.alias.is_empty()).collect()
}

/// Import các host từ ~/.ssh/config (bao gồm ProxyCommand cho Cloudflare Tunnel).
#[tauri::command]
pub async fn import_ssh_config(app: AppHandle, state: State<'_, AppState>) -> R<String> {
    let home = std::env::var("HOME").map_err(|_| "Không tìm thấy HOME".to_string())?;
    let path = format!("{home}/.ssh/config");
    let content = std::fs::read_to_string(&path).map_err(|err| format!("Không đọc được {path}: {err}"))?;
    let expand = |p: String| -> Option<String> {
        Some(if let Some(rest) = p.strip_prefix("~/") {
            format!("{home}/{rest}")
        } else {
            p
        })
    };
    let existing: std::collections::HashSet<String> = db::list_hosts(&state.db)
        .await
        .map_err(e)?
        .into_iter()
        .map(|h| h.label)
        .collect();
    let mut count = 0;
    for b in parse_ssh_config(&content) {
        if existing.contains(&b.alias) {
            continue;
        }
        let auth_type = if b.identity_file.is_some() { "key" } else { "password" };
        let input = HostInput {
            id: None,
            group_id: None,
            label: b.alias.clone(),
            address: b.hostname.unwrap_or_else(|| b.alias.clone()),
            port: b.port.unwrap_or(22),
            username: b.user.unwrap_or_else(|| "root".into()),
            auth_type: auth_type.into(),
            password: None,
            private_key_path: b.identity_file.and_then(expand),
            passphrase: None,
            key_id: None,
            startup_snippet: None,
            keepalive: false,
            term_theme: None,
            font_size: None,
            proxy_type: None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            jump_host_id: None,
            proxy_command: b.proxy_command,
            proxy_password: None,
        };
        db::upsert_host(&state.db, input).await.map_err(e)?;
        count += 1;
    }
    schedule_autosync(app, &state);
    Ok(format!("Imported {count} host(s) from ~/.ssh/config"))
}

// ----- SSH keys -----

#[tauri::command]
pub async fn get_keys(state: State<'_, AppState>) -> R<Vec<SshKey>> {
    db::list_keys(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn generate_key(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    algorithm: String,
    passphrase: Option<String>,
) -> R<SshKey> {
    let info = keys::generate(&algorithm, passphrase.as_deref(), &name).map_err(e)?;
    let k = store_key(&state.db, &name, &info, passphrase).await?;
    schedule_autosync(app, &state);
    Ok(k)
}

#[tauri::command]
pub async fn import_key(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    private_key: String,
    passphrase: Option<String>,
) -> R<SshKey> {
    let info = keys::inspect(&private_key, passphrase.as_deref()).map_err(e)?;
    let k = store_key(&state.db, &name, &info, passphrase).await?;
    schedule_autosync(app, &state);
    Ok(k)
}

async fn store_key(
    db: &SqlitePool,
    name: &str,
    info: &keys::KeyInfo,
    passphrase: Option<String>,
) -> R<SshKey> {
    let id = uuid::Uuid::new_v4().to_string();
    keychain::set_secret(&keychain::key_secret(&id), &info.private_pem).map_err(e)?;
    let has_pass = passphrase.as_deref().map(|p| !p.is_empty()).unwrap_or(false);
    if has_pass {
        keychain::set_secret(&keychain::key_passphrase(&id), passphrase.as_deref().unwrap())
            .map_err(e)?;
    }
    db::insert_key(
        db,
        &id,
        name,
        &info.algorithm,
        &info.public_key,
        &info.fingerprint,
        has_pass,
    )
    .await
    .map_err(e)
}

#[tauri::command]
pub async fn delete_key(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    keychain::delete_secret(&keychain::key_secret(&id)).ok();
    keychain::delete_secret(&keychain::key_passphrase(&id)).ok();
    db::delete_key(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

// ----- SSH sessions -----

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    cols: u32,
    rows: u32,
) -> R<String> {
    let host = db::get_host(&state.db, &host_id).await.map_err(e)?;
    let auth = resolve_auth(&host)?;
    let proxy = resolve_proxy(&host)?;
    let jump = resolve_jump(&state.db, &host, 0).await?;
    let addr = host.address.clone();
    let port = host.port as u16;
    let pcmd = host.proxy_command.clone();
    let expected = db::get_known_host(&state.db, &addr, port).await.map_err(e)?.map(|k| k.fingerprint);
    let res = state
        .ssh
        .connect(
            app,
            host.address,
            port,
            host.username,
            auth,
            cols,
            rows,
            host.startup_snippet,
            host.keepalive != 0,
            proxy,
            jump,
            expected,
            true,
            pcmd,
        )
        .await;
    res.map_err(|err| hostkey_error(err, &addr, port))
}

/// Đổi lỗi "HOSTKEY\t..." từ conn.rs sang định dạng cho frontend TOFU, kèm địa chỉ host.
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

// ----- Known hosts -----

#[tauri::command]
pub async fn known_hosts_list(state: State<'_, AppState>) -> R<Vec<db::KnownHost>> {
    db::list_known_hosts(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn known_hosts_add(
    state: State<'_, AppState>,
    host: String,
    port: u16,
    key_type: String,
    key_b64: String,
    fingerprint: String,
) -> R<()> {
    db::add_known_host(&state.db, &host, port, &key_type, &key_b64, &fingerprint).await.map_err(e)
}

#[tauri::command]
pub async fn known_hosts_delete(state: State<'_, AppState>, id: String) -> R<()> {
    db::delete_known_host(&state.db, &id).await.map_err(e)
}

// ----- SFTP -----

/// Mở SFTP tới server, trả về thư mục home.
#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, host_id: String) -> R<String> {
    let host = db::get_host(&state.db, &host_id).await.map_err(e)?;
    let auth = resolve_auth(&host)?;
    let proxy = resolve_proxy(&host)?;
    let jump = resolve_jump(&state.db, &host, 0).await?;
    let port = host.port as u16;
    let expected = db::get_known_host(&state.db, &host.address, port).await.map_err(e)?.map(|k| k.fingerprint);
    state
        .sftp
        .ensure_open(&host.id, &host.address, port, &host.username, auth, proxy, jump, expected, host.proxy_command.clone())
        .await
        .map_err(|err| {
            if err.to_string().starts_with("HOSTKEY\t") {
                format!("Host key for {}:{} doesn't match the saved key — open a terminal to this host to review it.", host.address, port)
            } else {
                err.to_string()
            }
        })
}

// ----- Tunnels (port forwarding) -----

#[tauri::command]
pub async fn get_tunnels(state: State<'_, AppState>) -> R<Vec<Tunnel>> {
    db::list_tunnels(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn upsert_tunnel(app: AppHandle, state: State<'_, AppState>, input: TunnelInput) -> R<Tunnel> {
    let t = db::upsert_tunnel(&state.db, input).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(t)
}

#[tauri::command]
pub async fn delete_tunnel(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    state.tunnels.stop(&id, &app).await;
    db::delete_tunnel(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

#[tauri::command]
pub async fn tunnel_active(state: State<'_, AppState>) -> R<Vec<String>> {
    Ok(state.tunnels.active_ids().await)
}

#[tauri::command]
pub async fn tunnel_start(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    let t = db::get_tunnel(&state.db, &id).await.map_err(e)?;
    let host = db::get_host(&state.db, &t.host_id).await.map_err(e)?;
    let auth = resolve_auth(&host)?;
    let proxy = resolve_proxy(&host)?;
    let jump = resolve_jump(&state.db, &host, 0).await?;
    let expected = db::get_known_host(&state.db, &host.address, host.port as u16)
        .await
        .map_err(e)?
        .map(|k| k.fingerprint);
    let spec = TunnelSpec {
        kind: t.kind,
        local_port: t.local_port as u16,
        remote_host: t.remote_host,
        remote_port: t.remote_port.map(|p| p as u16),
        address: host.address,
        port: host.port as u16,
        username: host.username,
        auth,
        proxy,
        jump,
        expected_hostkey: expected,
        proxy_command: host.proxy_command.clone(),
    };
    state.tunnels.start(app, id, spec).await.map_err(e)
}

#[tauri::command]
pub async fn tunnel_stop(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    state.tunnels.stop(&id, &app).await;
    Ok(())
}

// ----- Password manager entries -----

#[tauri::command]
pub async fn get_entries(state: State<'_, AppState>) -> R<Vec<VaultEntry>> {
    db::list_entries(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn upsert_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    input: VaultEntryInput,
) -> R<VaultEntry> {
    let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Mật khẩu: chỉ ghi khi có nhập (để trống khi sửa = giữ nguyên).
    if let Some(pw) = &input.password {
        if !pw.is_empty() {
            keychain::set_secret(&keychain::entry_password(&id), pw).map_err(e)?;
        }
    }
    // TOTP: Some(non-empty) = đặt; Some("") = xóa; None = giữ nguyên.
    let has_totp = match &input.totp_secret {
        Some(s) if !s.is_empty() => {
            keychain::set_secret(&keychain::entry_totp(&id), s).map_err(e)?;
            true
        }
        Some(_) => {
            keychain::delete_secret(&keychain::entry_totp(&id)).ok();
            false
        }
        None => keychain::get_secret(&keychain::entry_totp(&id)).map_err(e)?.is_some(),
    };

    let entry = db::upsert_entry(&state.db, &input, &id, has_totp).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(entry)
}

#[tauri::command]
pub async fn delete_entry(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    keychain::delete_secret(&keychain::entry_password(&id)).ok();
    keychain::delete_secret(&keychain::entry_totp(&id)).ok();
    db::delete_entry(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

/// Lấy mật khẩu của entry (để copy). Trả về chuỗi rỗng nếu chưa có.
#[tauri::command]
pub async fn entry_password(_state: State<'_, AppState>, id: String) -> R<String> {
    Ok(keychain::get_secret(&keychain::entry_password(&id))
        .map_err(e)?
        .unwrap_or_default())
}

#[derive(serde::Serialize)]
pub struct TotpCode {
    code: String,
    remaining: u64,
}

#[tauri::command]
pub async fn entry_totp_code(_state: State<'_, AppState>, id: String) -> R<TotpCode> {
    let secret = keychain::get_secret(&keychain::entry_totp(&id))
        .map_err(e)?
        .ok_or_else(|| "No TOTP secret for this entry".to_string())?;
    let (code, remaining) = crate::totp::code(&secret).map_err(e)?;
    Ok(TotpCode { code, remaining })
}

#[tauri::command]
pub async fn get_vault_folders(state: State<'_, AppState>) -> R<Vec<String>> {
    db::list_vault_folders(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn create_vault_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> R<()> {
    let path = path.trim().trim_matches('/').to_string();
    if path.is_empty() {
        return Err("Folder name is empty".into());
    }
    db::create_vault_folder(&state.db, &path).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

#[tauri::command]
pub async fn delete_vault_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> R<()> {
    // Xóa mọi entry trong thư mục (và thư mục con) + secret keychain, rồi xóa thư mục.
    let ids = db::entry_ids_in_folder(&state.db, &path).await.map_err(e)?;
    for id in &ids {
        keychain::delete_secret(&keychain::entry_password(id)).ok();
        keychain::delete_secret(&keychain::entry_totp(id)).ok();
        db::delete_entry(&state.db, id).await.map_err(e)?;
    }
    db::delete_vault_folder(&state.db, &path).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

#[tauri::command]
pub async fn rename_vault_folder(app: AppHandle, state: State<'_, AppState>, old: String, new: String) -> R<()> {
    let new = new.trim().trim_matches('/').to_string();
    if new.is_empty() {
        return Err("Folder name is empty".into());
    }
    db::rename_vault_folder(&state.db, &old, &new).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
}

// ----- Khóa ứng dụng (mở tool bằng mật khẩu) -----

const APPLOCK: &str = "applock";
const APPLOCK_TIMEOUT: &str = "applock-timeout";
const APPLOCK_TOTP: &str = "applock-totp";
const APPLOCK_REAUTH: &str = "applock-reauth";

#[derive(serde::Serialize)]
pub struct AppLockStatus {
    enabled: bool,
    timeout_mins: u32,
    totp_enabled: bool,
    reauth_mins: u32,
}

#[tauri::command]
pub async fn applock_status() -> R<AppLockStatus> {
    let enabled = keychain::get_secret(APPLOCK).map_err(e)?.is_some();
    let timeout_mins = keychain::get_secret(APPLOCK_TIMEOUT)
        .map_err(e)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let totp_enabled = keychain::get_secret(APPLOCK_TOTP).map_err(e)?.is_some();
    let reauth_mins = keychain::get_secret(APPLOCK_REAUTH)
        .map_err(e)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(AppLockStatus { enabled, timeout_mins, totp_enabled, reauth_mins })
}

#[derive(serde::Serialize)]
pub struct TotpSetup {
    secret: String,
    uri: String,
    qr_svg: String,
}

/// Tạo secret 2FA mới (chưa bật) + URL + QR để quét.
#[tauri::command]
pub async fn applock_totp_setup() -> R<TotpSetup> {
    let secret = crate::totp::generate_secret_b32();
    let uri = crate::totp::otpauth_url(&secret).map_err(e)?;
    let qr_svg = qrcode::QrCode::new(uri.as_bytes())
        .map(|c| c.render::<qrcode::render::svg::Color>().min_dimensions(180, 180).build())
        .unwrap_or_default();
    Ok(TotpSetup { secret, uri, qr_svg })
}

/// Bật 2FA: xác minh mã người dùng nhập khớp secret rồi mới lưu.
#[tauri::command]
pub async fn applock_totp_enable(secret: String, code: String) -> R<()> {
    if !crate::totp::verify(&secret, &code) {
        return Err("Code doesn't match — check your authenticator app.".into());
    }
    keychain::set_secret(APPLOCK_TOTP, secret.trim()).map_err(e)?;
    Ok(())
}

/// Tắt 2FA (cần đúng mật khẩu app).
#[tauri::command]
pub async fn applock_totp_disable(password: String) -> R<()> {
    match keychain::get_secret(APPLOCK).map_err(e)? {
        Some(phc) if crate::applock::verify(&password, &phc) => {
            keychain::delete_secret(APPLOCK_TOTP).ok();
            Ok(())
        }
        Some(_) => Err("Wrong password".into()),
        None => Ok(()),
    }
}

/// Đặt khoảng thời gian (phút) buộc xác thực lại (kể cả đang hoạt động). 0 = tắt.
#[tauri::command]
pub async fn applock_set_reauth(reauth_mins: u32) -> R<()> {
    keychain::set_secret(APPLOCK_REAUTH, &reauth_mins.to_string()).map_err(e)?;
    Ok(())
}

/// Mở khóa: kiểm tra mật khẩu + (nếu bật) mã 2FA.
#[tauri::command]
pub async fn applock_unlock(password: String, code: Option<String>) -> R<bool> {
    match keychain::get_secret(APPLOCK).map_err(e)? {
        Some(phc) => {
            if !crate::applock::verify(&password, &phc) {
                return Ok(false);
            }
        }
        None => return Ok(true),
    }
    if let Some(secret) = keychain::get_secret(APPLOCK_TOTP).map_err(e)? {
        if !crate::totp::verify(&secret, code.as_deref().unwrap_or("")) {
            return Ok(false);
        }
    }
    Ok(true)
}

#[tauri::command]
pub async fn applock_enable(password: String, timeout_mins: u32) -> R<()> {
    if password.trim().is_empty() {
        return Err("Password is empty".into());
    }
    let phc = crate::applock::hash(&password).map_err(e)?;
    keychain::set_secret(APPLOCK, &phc).map_err(e)?;
    keychain::set_secret(APPLOCK_TIMEOUT, &timeout_mins.to_string()).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub async fn applock_disable(password: String) -> R<()> {
    match keychain::get_secret(APPLOCK).map_err(e)? {
        Some(phc) if crate::applock::verify(&password, &phc) => {
            keychain::delete_secret(APPLOCK).map_err(e)?;
            keychain::delete_secret(APPLOCK_TIMEOUT).ok();
            keychain::delete_secret(APPLOCK_TOTP).ok();
            keychain::delete_secret(APPLOCK_REAUTH).ok();
            Ok(())
        }
        Some(_) => Err("Wrong password".into()),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn applock_verify(password: String) -> R<bool> {
    match keychain::get_secret(APPLOCK).map_err(e)? {
        Some(phc) => Ok(crate::applock::verify(&password, &phc)),
        None => Ok(true),
    }
}

#[tauri::command]
pub async fn applock_set_timeout(timeout_mins: u32) -> R<()> {
    keychain::set_secret(APPLOCK_TIMEOUT, &timeout_mins.to_string()).map_err(e)?;
    Ok(())
}

// ----- Thông tin app + kiểm tra cập nhật -----

const RELEASES_API: &str = "https://api.github.com/repos/minhngoc2512/termez/releases/latest";

#[derive(serde::Serialize)]
pub struct UpdateInfo {
    current: String,
    latest: String,
    has_update: bool,
    url: String,
    notes: String,
}

/// Phiên bản hiện tại (lấy từ Cargo.toml lúc biên dịch).
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// So sánh với release mới nhất trên GitHub.
#[tauri::command]
pub async fn check_update() -> R<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let resp = reqwest::Client::new()
        .get(RELEASES_API)
        .header("User-Agent", "Termez")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(e)?;
    // Chưa publish release nào — coi như đang ở bản mới nhất.
    if resp.status().as_u16() == 404 {
        return Ok(UpdateInfo {
            latest: current.clone(),
            current,
            has_update: false,
            url: String::new(),
            notes: String::new(),
        });
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub {}", resp.status()));
    }
    let j: serde_json::Value = resp.json().await.map_err(e)?;
    let latest = j["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    let url = j["html_url"].as_str().unwrap_or("").to_string();
    let notes = j["body"].as_str().unwrap_or("").to_string();
    let has_update = version_gt(&latest, &current);
    Ok(UpdateInfo { current, latest, has_update, url, notes })
}

/// So sánh semver rút gọn: `a` mới hơn `b`?
fn version_gt(a: &str, b: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.split(['.', '-'])
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    }
    let (pa, pb) = (parts(a), parts(b));
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Cập nhật gói `termez` qua apt. Dùng `pkexec` để polkit hỏi mật khẩu (app
/// KHÔNG chạm vào mật khẩu). Chỉ hợp lệ khi cài qua apt/.deb.
#[tauri::command]
pub async fn update_apply() -> R<String> {
    let out = tokio::process::Command::new("pkexec")
        .arg("sh")
        .arg("-c")
        .arg("apt-get update -qq && apt-get install -y --only-upgrade termez")
        .output()
        .await
        .map_err(|err| format!("Không chạy được pkexec/apt: {err}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let code = out.status.code().unwrap_or(-1);
        // pkexec: 126 = user hủy/không có quyền, 127 = lỗi xác thực.
        let stderr = String::from_utf8_lossy(&out.stderr);
        if code == 126 || code == 127 {
            Err("Đã hủy hoặc xác thực thất bại.".into())
        } else {
            Err(format!("apt lỗi ({code}): {}", stderr.trim()))
        }
    }
}

/// Lấy changelog (body) của một release theo tag — dùng cho popup sau khi update.
#[tauri::command]
pub async fn release_notes(tag: String) -> R<String> {
    let url = format!("https://api.github.com/repos/minhngoc2512/termez/releases/tags/{tag}");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Termez")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(e)?;
    if !resp.status().is_success() {
        return Ok(String::new());
    }
    let j: serde_json::Value = resp.json().await.map_err(e)?;
    Ok(j["body"].as_str().unwrap_or("").to_string())
}

/// Khởi động lại app (sau khi cập nhật xong).
#[tauri::command]
pub fn app_relaunch(app: AppHandle) {
    app.restart();
}

// ----- Quét mạng (TCP connect) -----

#[tauri::command]
pub async fn scan_hosts(
    cidr: String,
    port: u16,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> R<Vec<String>> {
    crate::scan::scan_hosts(&cidr, port, timeout_ms.unwrap_or(400), concurrency.unwrap_or(256))
        .await
        .map_err(e)
}

#[tauri::command]
pub async fn scan_ports(
    target: String,
    ports: Vec<u16>,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> R<Vec<u16>> {
    crate::scan::scan_ports(&target, ports, timeout_ms.unwrap_or(500), concurrency.unwrap_or(256))
        .await
        .map_err(e)
}

#[tauri::command]
pub async fn scan_lan(
    cidr: String,
    timeout_ms: Option<u64>,
    concurrency: Option<usize>,
) -> R<Vec<crate::scan::LanDevice>> {
    crate::scan::scan_lan(&cidr, timeout_ms.unwrap_or(500), concurrency.unwrap_or(256))
        .await
        .map_err(e)
}

#[tauri::command]
pub async fn local_cidr() -> R<Option<String>> {
    Ok(crate::scan::local_cidr())
}

// ----- Cloudflare DNS -----

const CF_TOKEN: &str = "cf-token";
const CF_URL: &str = "cf-url";
const CF_ACCOUNT: &str = "cf-account";

#[derive(serde::Serialize)]
pub struct CfConfig {
    api_url: String,
    account_id: String,
    has_token: bool,
}

fn cf_client() -> R<crate::cloudflare::CfClient> {
    let token = keychain::get_secret(CF_TOKEN)
        .map_err(e)?
        .ok_or_else(|| "Cloudflare API token is not set".to_string())?;
    let url = keychain::get_secret(CF_URL)
        .map_err(e)?
        .unwrap_or_else(|| crate::cloudflare::DEFAULT_BASE.to_string());
    Ok(crate::cloudflare::CfClient::new(url, token))
}

#[tauri::command]
pub async fn cf_get_config() -> R<CfConfig> {
    Ok(CfConfig {
        api_url: keychain::get_secret(CF_URL)
            .map_err(e)?
            .unwrap_or_else(|| crate::cloudflare::DEFAULT_BASE.to_string()),
        account_id: keychain::get_secret(CF_ACCOUNT).map_err(e)?.unwrap_or_default(),
        has_token: keychain::get_secret(CF_TOKEN).map_err(e)?.is_some(),
    })
}

#[tauri::command]
pub async fn cf_save_config(api_url: String, account_id: String, token: Option<String>) -> R<()> {
    let url = if api_url.trim().is_empty() {
        crate::cloudflare::DEFAULT_BASE.to_string()
    } else {
        api_url.trim().to_string()
    };
    keychain::set_secret(CF_URL, &url).map_err(e)?;
    keychain::set_secret(CF_ACCOUNT, account_id.trim()).map_err(e)?;
    if let Some(t) = token {
        if !t.trim().is_empty() {
            keychain::set_secret(CF_TOKEN, t.trim()).map_err(e)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cf_clear_config() -> R<()> {
    keychain::delete_secret(CF_TOKEN).ok();
    keychain::delete_secret(CF_URL).ok();
    keychain::delete_secret(CF_ACCOUNT).ok();
    Ok(())
}

#[tauri::command]
pub async fn cf_verify() -> R<()> {
    cf_client()?.verify().await.map_err(e)
}

#[tauri::command]
pub async fn cf_list_zones() -> R<Vec<crate::cloudflare::Zone>> {
    let account = keychain::get_secret(CF_ACCOUNT).map_err(e)?;
    cf_client()?.list_zones(account.as_deref()).await.map_err(e)
}

#[tauri::command]
pub async fn cf_list_records(zone_id: String) -> R<Vec<crate::cloudflare::DnsRecord>> {
    cf_client()?.list_records(&zone_id).await.map_err(e)
}

#[tauri::command]
pub async fn cf_create_record(
    zone_id: String,
    input: crate::cloudflare::DnsInput,
) -> R<crate::cloudflare::DnsRecord> {
    cf_client()?.create_record(&zone_id, &input).await.map_err(e)
}

#[tauri::command]
pub async fn cf_update_record(
    zone_id: String,
    id: String,
    input: crate::cloudflare::DnsInput,
) -> R<crate::cloudflare::DnsRecord> {
    cf_client()?.update_record(&zone_id, &id, &input).await.map_err(e)
}

#[tauri::command]
pub async fn cf_delete_record(zone_id: String, id: String) -> R<()> {
    cf_client()?.delete_record(&zone_id, &id).await.map_err(e)
}

// ----- Lưu trữ S3/R2/MinIO -----

async fn s3_for(db: &SqlitePool, bucket_id: &str) -> R<crate::s3::S3> {
    let b = db::get_bucket(db, bucket_id).await.map_err(e)?;
    let secret = keychain::get_secret(&keychain::storage_secret(bucket_id))
        .map_err(e)?
        .ok_or_else(|| "Secret key is not set for this connection".to_string())?;
    Ok(crate::s3::S3::new(
        b.endpoint,
        b.region.unwrap_or_default(),
        b.access_key,
        secret,
        b.bucket,
    ))
}

#[tauri::command]
pub async fn get_buckets(state: State<'_, AppState>) -> R<Vec<db::StorageBucket>> {
    db::list_buckets(&state.db).await.map_err(e)
}

#[tauri::command]
pub async fn upsert_bucket(
    state: State<'_, AppState>,
    input: db::StorageBucketInput,
) -> R<db::StorageBucket> {
    let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let bucket = db::upsert_bucket(&state.db, &input, &id).await.map_err(e)?;
    if let Some(secret) = &input.secret_key {
        if !secret.trim().is_empty() {
            keychain::set_secret(&keychain::storage_secret(&id), secret).map_err(e)?;
        }
    }
    Ok(bucket)
}

#[tauri::command]
pub async fn delete_bucket(state: State<'_, AppState>, id: String) -> R<()> {
    db::delete_bucket(&state.db, &id).await.map_err(e)?;
    keychain::delete_secret(&keychain::storage_secret(&id)).ok();
    Ok(())
}

#[tauri::command]
pub async fn s3_list(
    state: State<'_, AppState>,
    bucket_id: String,
    prefix: String,
) -> R<crate::s3::Listing> {
    s3_for(&state.db, &bucket_id).await?.list(&prefix, None).await.map_err(e)
}

#[tauri::command]
pub async fn s3_upload(
    state: State<'_, AppState>,
    bucket_id: String,
    key: String,
    file_path: String,
) -> R<()> {
    s3_for(&state.db, &bucket_id).await?.put_file(&key, &file_path).await.map_err(e)
}

#[tauri::command]
pub async fn s3_delete(state: State<'_, AppState>, bucket_id: String, key: String) -> R<()> {
    s3_for(&state.db, &bucket_id).await?.delete(&key).await.map_err(e)
}

#[tauri::command]
pub async fn s3_presign(
    state: State<'_, AppState>,
    bucket_id: String,
    key: String,
    expires: u64,
) -> R<String> {
    let s3 = s3_for(&state.db, &bucket_id).await?;
    Ok(s3.presign_get(&key, expires))
}

/// Copy/move một object. `move_it = true` → xóa nguồn sau khi copy.
#[tauri::command]
pub async fn s3_copy(
    state: State<'_, AppState>,
    bucket_id: String,
    src_key: String,
    dst_key: String,
    move_it: bool,
) -> R<()> {
    if src_key == dst_key {
        return Ok(());
    }
    let s3 = s3_for(&state.db, &bucket_id).await?;
    s3.copy(&src_key, &dst_key).await.map_err(e)?;
    if move_it {
        s3.delete(&src_key).await.map_err(e)?;
    }
    Ok(())
}

/// Duyệt các path cục bộ → danh sách (local, key trên bucket, size). Thư mục đi đệ quy.
fn plan_uploads(paths: &[String], prefix: &str) -> Vec<(String, String, u64)> {
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::Path::new(p);
        let Ok(meta) = std::fs::metadata(path) else { continue };
        if meta.is_file() {
            if let Some(name) = path.file_name() {
                out.push((p.clone(), format!("{prefix}{}", name.to_string_lossy()), meta.len()));
            }
        } else if meta.is_dir() {
            let base = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            for entry in walkdir::WalkDir::new(path).into_iter().flatten() {
                if entry.file_type().is_file() {
                    let rel = entry.path().strip_prefix(path).unwrap_or(entry.path())
                        .to_string_lossy().replace('\\', "/");
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    out.push((entry.path().to_string_lossy().to_string(), format!("{prefix}{base}/{rel}"), size));
                }
            }
        }
    }
    out
}

#[derive(serde::Serialize)]
pub struct UploadPlan {
    count: usize,
    total: u64,
    conflicts: Vec<String>,
}

#[tauri::command]
pub async fn s3_upload_plan(
    state: State<'_, AppState>,
    bucket_id: String,
    prefix: String,
    paths: Vec<String>,
) -> R<UploadPlan> {
    let p = prefix.clone();
    let planned = tokio::task::spawn_blocking(move || plan_uploads(&paths, &p)).await.map_err(e)?;
    let total = planned.iter().map(|x| x.2).sum();
    let s3 = s3_for(&state.db, &bucket_id).await?;
    let existing: std::collections::HashSet<String> =
        s3.list_all_keys(&prefix).await.map_err(e)?.into_iter().collect();
    let conflicts: Vec<String> = planned
        .iter()
        .filter(|x| existing.contains(&x.1))
        .map(|x| x.1.clone())
        .take(200)
        .collect();
    Ok(UploadPlan { count: planned.len(), total, conflicts })
}

/// Upload nhiều file/thư mục, phát event "s3:progress". mode: overwrite | skip | replace.
#[tauri::command]
pub async fn s3_upload_run(
    app: AppHandle,
    state: State<'_, AppState>,
    bucket_id: String,
    prefix: String,
    paths: Vec<String>,
    mode: String,
) -> R<u32> {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    let p = prefix.clone();
    let paths2 = paths.clone();
    let planned = tokio::task::spawn_blocking(move || plan_uploads(&paths2, &p)).await.map_err(e)?;
    let s3 = s3_for(&state.db, &bucket_id).await?;

    let existing: std::collections::HashSet<String> = if mode == "skip" {
        s3.list_all_keys(&prefix).await.map_err(e)?.into_iter().collect()
    } else {
        std::collections::HashSet::new()
    };

    if mode == "replace" {
        for pth in &paths {
            let path = std::path::Path::new(pth);
            if path.is_dir() {
                if let Some(name) = path.file_name() {
                    let pfx = format!("{prefix}{}/", name.to_string_lossy());
                    for k in s3.list_all_keys(&pfx).await.map_err(e)? {
                        s3.delete(&k).await.ok();
                    }
                }
            }
        }
    }

    let total: u64 = planned.iter().map(|x| x.2).sum();
    let done = Arc::new(AtomicU64::new(0));
    let fin = Arc::new(AtomicBool::new(false));
    let cur = Arc::new(Mutex::new(String::new()));

    {
        let (app, done, fin, cur) = (app.clone(), done.clone(), fin.clone(), cur.clone());
        tokio::spawn(async move {
            let mut last = 0u64;
            let mut last_t = std::time::Instant::now();
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                if fin.load(Ordering::Relaxed) {
                    break;
                }
                let d = done.load(Ordering::Relaxed);
                let now = std::time::Instant::now();
                let dt = now.duration_since(last_t).as_secs_f64().max(1e-3);
                let speed = d.saturating_sub(last) as f64 / dt;
                let file = cur.lock().unwrap().clone();
                let _ = app.emit(
                    "s3:progress",
                    serde_json::json!({"done":d,"total":total,"speed":speed,"file":file,"fin":false}),
                );
                last = d;
                last_t = now;
            }
        });
    }

    let mut count = 0u32;
    for (local, key, size) in planned {
        if mode == "skip" && existing.contains(&key) {
            done.fetch_add(size, Ordering::Relaxed);
            continue;
        }
        *cur.lock().unwrap() = key.clone();
        if let Err(err) = s3.put_counting(&key, &local, done.clone()).await {
            fin.store(true, Ordering::Relaxed);
            return Err(e(err));
        }
        count += 1;
    }
    fin.store(true, Ordering::Relaxed);
    let _ = app.emit("s3:progress", serde_json::json!({"done":total,"total":total,"speed":0.0,"file":"","fin":true}));
    Ok(count)
}

#[tauri::command]
pub async fn s3_create_folder(state: State<'_, AppState>, bucket_id: String, key: String) -> R<()> {
    let key = if key.ends_with('/') { key } else { format!("{key}/") };
    s3_for(&state.db, &bucket_id).await?.put_empty(&key).await.map_err(e)
}

#[tauri::command]
pub async fn s3_download(
    state: State<'_, AppState>,
    bucket_id: String,
    key: String,
    dest_path: String,
) -> R<()> {
    s3_for(&state.db, &bucket_id).await?.get_to_file(&key, &dest_path).await.map_err(e)
}

/// Xóa cả "thư mục": mọi object dưới `prefix`.
#[tauri::command]
pub async fn s3_delete_prefix(
    state: State<'_, AppState>,
    bucket_id: String,
    prefix: String,
) -> R<u32> {
    let s3 = s3_for(&state.db, &bucket_id).await?;
    let keys = s3.list_all_keys(&prefix).await.map_err(e)?;
    let mut count = 0;
    for k in keys {
        s3.delete(&k).await.map_err(e)?;
        count += 1;
    }
    Ok(count)
}

/// Copy/move cả "thư mục" (mọi object dưới `src_prefix`) sang `dst_prefix`.
#[tauri::command]
pub async fn s3_copy_prefix(
    state: State<'_, AppState>,
    bucket_id: String,
    src_prefix: String,
    dst_prefix: String,
    move_it: bool,
) -> R<u32> {
    if src_prefix == dst_prefix || dst_prefix.starts_with(&src_prefix) {
        return Err("Cannot copy a folder into itself".into());
    }
    let s3 = s3_for(&state.db, &bucket_id).await?;
    let keys = s3.list_all_keys(&src_prefix).await.map_err(e)?;
    let mut count = 0;
    for k in keys {
        let dst = format!("{}{}", dst_prefix, &k[src_prefix.len()..]);
        s3.copy(&k, &dst).await.map_err(e)?;
        if move_it {
            s3.delete(&k).await.map_err(e)?;
        }
        count += 1;
    }
    Ok(count)
}

/// Chuyển 1 object giữa 2 bucket qua file tạm (tải nguồn → đẩy đích). Chạy được mọi cặp provider.
async fn transfer_one(
    src: &crate::s3::S3,
    dst: &crate::s3::S3,
    src_key: &str,
    dst_key: &str,
) -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join(format!("termez-xfer-{}", uuid::Uuid::new_v4()));
    let tmp_s = tmp.to_string_lossy().to_string();
    let res = async {
        src.get_to_file(src_key, &tmp_s).await?;
        dst.put_file(dst_key, &tmp_s).await
    }
    .await;
    let _ = std::fs::remove_file(&tmp);
    res
}

#[tauri::command]
pub async fn s3_transfer(
    state: State<'_, AppState>,
    src_bucket_id: String,
    src_key: String,
    dst_bucket_id: String,
    dst_key: String,
) -> R<()> {
    let src = s3_for(&state.db, &src_bucket_id).await?;
    let dst = s3_for(&state.db, &dst_bucket_id).await?;
    transfer_one(&src, &dst, &src_key, &dst_key).await.map_err(e)
}

/// Chuyển cả "thư mục" giữa 2 bucket. Phát event "s3:xfer" tiến trình theo từng file.
#[tauri::command]
pub async fn s3_transfer_prefix(
    app: AppHandle,
    state: State<'_, AppState>,
    src_bucket_id: String,
    src_prefix: String,
    dst_bucket_id: String,
    dst_prefix: String,
) -> R<u32> {
    let src = s3_for(&state.db, &src_bucket_id).await?;
    let dst = s3_for(&state.db, &dst_bucket_id).await?;
    let keys = src.list_all_keys(&src_prefix).await.map_err(e)?;
    let total = keys.len();
    let mut count = 0u32;
    for k in keys {
        let dst_key = format!("{}{}", dst_prefix, &k[src_prefix.len()..]);
        transfer_one(&src, &dst, &k, &dst_key).await.map_err(e)?;
        count += 1;
        let _ = app.emit(
            "s3:xfer",
            serde_json::json!({ "done": count, "total": total, "file": k, "fin": false }),
        );
    }
    let _ = app.emit("s3:xfer", serde_json::json!({ "done": total, "total": total, "file": "", "fin": true }));
    Ok(count)
}

#[derive(serde::Deserialize)]
struct ImportedEntry {
    title: String,
    username: Option<String>,
    password: Option<String>,
    url: Option<String>,
    notes: Option<String>,
    totp: Option<String>,
    #[serde(default)]
    group: Option<String>,
}

#[derive(serde::Deserialize)]
struct SidecarOutput {
    ok: bool,
    #[serde(default)]
    entries: Vec<ImportedEntry>,
    #[serde(default)]
    error: Option<String>,
}

/// Tìm binary sidecar `kdbx-import`: cạnh app (bản đóng gói/dev do Tauri copy),
/// hoặc trong thư mục `binaries/` của src-tauri (khi chạy dev từ mã nguồn).
fn kdbx_sidecar_path() -> Option<std::path::PathBuf> {
    let matches = |name: &std::ffi::OsStr| {
        let s = name.to_string_lossy();
        s == "kdbx-import" || s.starts_with("kdbx-import-") || s.starts_with("kdbx-import.")
    };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for ent in rd.flatten() {
                    if matches(&ent.file_name()) {
                        return Some(ent.path());
                    }
                }
            }
        }
    }
    let mut dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dev.push("binaries");
    if let Ok(rd) = std::fs::read_dir(&dev) {
        for ent in rd.flatten() {
            if matches(&ent.file_name()) {
                return Some(ent.path());
            }
        }
    }
    None
}

/// Import các entry từ file KeePass (.kdbx) vào vault, qua sidecar tách biệt.
#[tauri::command]
pub async fn import_kdbx(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> R<String> {
    let bin = kdbx_sidecar_path()
        .ok_or_else(|| "Không tìm thấy trình import KeePass (kdbx-import).".to_string())?;

    let imported = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<ImportedEntry>> {
        use std::io::Write;
        let mut child = std::process::Command::new(&bin)
            .arg(&path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        // Ghi mật khẩu vào stdin rồi đóng (EOF) để sidecar đọc xong.
        child
            .stdin
            .take()
            .expect("stdin piped")
            .write_all(password.as_bytes())?;
        let output = child.wait_with_output()?;
        let parsed: SidecarOutput = serde_json::from_slice(&output.stdout)
            .map_err(|e| anyhow::anyhow!("Kết quả sidecar không hợp lệ: {e}"))?;
        if !parsed.ok {
            anyhow::bail!(parsed.error.unwrap_or_else(|| "Import thất bại.".into()));
        }
        Ok(parsed.entries)
    })
    .await
    .map_err(e)?
    .map_err(e)?;

    let mut count = 0;
    let mut folders: std::collections::HashSet<String> = std::collections::HashSet::new();
    for it in imported {
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(pw) = &it.password {
            if !pw.is_empty() {
                keychain::set_secret(&keychain::entry_password(&id), pw).map_err(e)?;
            }
        }
        let has_totp = if let Some(t) = &it.totp {
            keychain::set_secret(&keychain::entry_totp(&id), t).map_err(e)?;
            true
        } else {
            false
        };
        // Giữ nguyên cấu trúc thư mục KeePass dưới "Imported/".
        let folder = match it.group.as_deref() {
            Some(g) if !g.is_empty() => format!("Imported/{g}"),
            _ => "Imported".to_string(),
        };
        // Ghi lại mọi cấp thư mục để cây folder đầy đủ (kể cả nhóm rỗng-ish).
        let mut acc = String::new();
        for seg in folder.split('/') {
            acc = if acc.is_empty() { seg.to_string() } else { format!("{acc}/{seg}") };
            folders.insert(acc.clone());
        }
        let input = VaultEntryInput {
            id: Some(id.clone()),
            title: it.title,
            username: it.username,
            url: it.url,
            notes: it.notes,
            tags: None,
            folder: Some(folder),
            linked_host_id: None,
            password: None,
            totp_secret: None,
        };
        db::upsert_entry(&state.db, &input, &id, has_totp).await.map_err(e)?;
        count += 1;
    }
    for f in &folders {
        db::create_vault_folder(&state.db, f).await.ok();
    }
    schedule_autosync(app, &state);
    Ok(format!("Imported {count} entries from KeePass"))
}

// ----- Cloud sync (GitHub) -----

const SYNC_PAT: &str = "sync:pat";
const SYNC_REPO: &str = "sync:repo";
const SYNC_MASTER: &str = "sync:master";
const SYNC_AUTO: &str = "sync:auto";

#[derive(serde::Serialize)]
pub struct SyncConfig {
    repo: Option<String>,
    has_pat: bool,
    auto: bool,
}

#[tauri::command]
pub async fn sync_get_config(_state: State<'_, AppState>) -> R<SyncConfig> {
    let repo = keychain::get_secret(SYNC_REPO).map_err(e)?;
    let has_pat = keychain::get_secret(SYNC_PAT).map_err(e)?.is_some();
    let auto = keychain::get_secret(SYNC_AUTO).map_err(e)?.as_deref() == Some("1");
    Ok(SyncConfig { repo, has_pat, auto })
}

/// Bật/tắt auto-sync. Khi bật, lưu master password vào keychain để tự mã hóa khi backup.
#[tauri::command]
pub async fn sync_set_auto(
    _state: State<'_, AppState>,
    enabled: bool,
    master: Option<String>,
) -> R<()> {
    if enabled {
        let m = master.filter(|m| !m.is_empty());
        if let Some(m) = m {
            keychain::set_secret(SYNC_MASTER, &m).map_err(e)?;
        } else if keychain::get_secret(SYNC_MASTER).map_err(e)?.is_none() {
            return Err("Enter your master password to enable auto-sync".into());
        }
        keychain::set_secret(SYNC_AUTO, "1").map_err(e)?;
    } else {
        keychain::delete_secret(SYNC_AUTO).ok();
        keychain::delete_secret(SYNC_MASTER).ok();
    }
    Ok(())
}

const SYNC_SHA: &str = "sync:sha";

fn get_last_sha() -> Option<String> {
    keychain::get_secret(SYNC_SHA).ok().flatten().filter(|s| !s.is_empty())
}
fn set_last_sha(sha: &str) {
    let _ = keychain::set_secret(SYNC_SHA, sha);
}

enum PushOutcome {
    Pushed(String),
    Conflict,
}
enum PullOutcome {
    UpToDate,
    Pulled,
    Conflict,
}

/// Gom toàn bộ dữ liệu + secret → mã hóa E2E → (content base64, mô tả).
async fn build_vault_content(db: &SqlitePool, master: &str) -> anyhow::Result<(String, String)> {
    let hosts = db::list_hosts(db).await?;
    let groups = db::list_groups(db).await?;
    let keys = db::list_keys(db).await?;
    let tunnels = db::list_tunnels(db).await?;
    let entries = db::list_entries(db).await?;
    let folders = db::list_vault_folders(db).await?;
    let buckets = db::list_buckets(db).await?;

    let mut secrets = std::collections::HashMap::new();
    for b in &buckets {
        let acc = keychain::storage_secret(&b.id);
        if let Some(v) = keychain::get_secret(&acc)? {
            secrets.insert(acc, v);
        }
    }
    for h in &hosts {
        for acc in [keychain::host_password(&h.id), keychain::proxy_password(&h.id)] {
            if let Some(v) = keychain::get_secret(&acc)? {
                secrets.insert(acc, v);
            }
        }
    }
    for k in &keys {
        for acc in [keychain::key_secret(&k.id), keychain::key_passphrase(&k.id)] {
            if let Some(v) = keychain::get_secret(&acc)? {
                secrets.insert(acc, v);
            }
        }
    }
    for en in &entries {
        for acc in [keychain::entry_password(&en.id), keychain::entry_totp(&en.id)] {
            if let Some(v) = keychain::get_secret(&acc)? {
                secrets.insert(acc, v);
            }
        }
    }

    let vault = sync::Vault { version: 1, hosts, groups, keys, tunnels, entries, folders, buckets, secrets };
    let json = serde_json::to_vec(&vault)?;
    let enc = sync::encrypt(&json, master)?;
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&enc);
    let summary = format!(
        "Pushed {} hosts, {} keys, {} tunnels",
        vault.hosts.len(),
        vault.keys.len(),
        vault.tunnels.len()
    );
    Ok((content_b64, summary))
}

/// Đẩy lên GitHub. Nếu `force=false` và remote đã đổi so với mốc đã đồng bộ → Conflict.
async fn do_push(
    db: &SqlitePool,
    master: &str,
    pat: &str,
    owner: &str,
    repo: &str,
    force: bool,
) -> anyhow::Result<PushOutcome> {
    let (content, summary) = build_vault_content(db, master).await?;
    let remote_sha = sync::get_vault(pat, owner, repo).await?.map(|(_, s)| s);
    let last = get_last_sha();
    if !force {
        let diverged = match (&remote_sha, &last) {
            (Some(rs), Some(ls)) => rs != ls,
            (Some(_), None) => true, // remote có data nhưng ta chưa từng đồng bộ
            _ => false,
        };
        if diverged {
            return Ok(PushOutcome::Conflict);
        }
    }
    let new_sha = sync::put_vault(pat, owner, repo, &content, remote_sha, "Termez vault update").await?;
    set_last_sha(&new_sha);
    Ok(PushOutcome::Pushed(summary))
}

/// Kéo về + áp dụng. Nếu remote đổi và local đang dirty (chưa push) và !force → Conflict.
async fn do_pull(
    db: &SqlitePool,
    master: &str,
    pat: &str,
    owner: &str,
    repo: &str,
    dirty: bool,
    force: bool,
) -> anyhow::Result<PullOutcome> {
    let Some((content_b64, sha)) = sync::get_vault(pat, owner, repo).await? else {
        return Ok(PullOutcome::UpToDate);
    };
    if get_last_sha().as_deref() == Some(&sha) {
        return Ok(PullOutcome::UpToDate);
    }
    if dirty && !force {
        return Ok(PullOutcome::Conflict);
    }
    let enc = base64::engine::general_purpose::STANDARD.decode(content_b64.as_bytes())?;
    let json = sync::decrypt(&enc, master)?;
    let vault: sync::Vault = serde_json::from_slice(&json)?;
    db::import_all(
        db,
        &vault.hosts,
        &vault.groups,
        &vault.keys,
        &vault.tunnels,
        &vault.entries,
        &vault.folders,
        &vault.buckets,
    )
    .await?;
    for (acc, val) in &vault.secrets {
        keychain::set_secret(acc, val)?;
    }
    set_last_sha(&sha);
    Ok(PullOutcome::Pulled)
}

/// Lên lịch auto-backup (debounce 3s) sau mỗi thay đổi dữ liệu.
pub fn schedule_autosync(app: AppHandle, state: &AppState) {
    if keychain::get_secret(SYNC_AUTO).ok().flatten().as_deref() != Some("1") {
        return;
    }
    state.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    let pool = state.db.clone();
    let dirty = state.dirty.clone();
    let mut guard = state.autosync.lock().unwrap();
    if let Some(h) = guard.take() {
        h.abort();
    }
    let handle = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let (master, pat, repo) = match (
            keychain::get_secret(SYNC_MASTER).ok().flatten(),
            keychain::get_secret(SYNC_PAT).ok().flatten(),
            keychain::get_secret(SYNC_REPO).ok().flatten(),
        ) {
            (Some(m), Some(p), Some(r)) => (m, p, r),
            _ => return,
        };
        let Ok((owner, r)) = sync::parse_repo(&repo) else {
            return;
        };
        match do_push(&pool, &master, &pat, &owner, &r, false).await {
            Ok(PushOutcome::Pushed(msg)) => {
                dirty.store(false, std::sync::atomic::Ordering::Relaxed);
                let _ = app.emit("sync:auto", serde_json::json!({ "ok": true, "message": msg }));
            }
            Ok(PushOutcome::Conflict) => {
                let _ = app.emit("sync:conflict", ());
                let _ = app.emit("sync:auto", serde_json::json!({ "ok": false, "message": "conflict" }));
            }
            Err(e) => {
                let _ = app.emit("sync:auto", serde_json::json!({ "ok": false, "message": e.to_string() }));
            }
        }
    });
    *guard = Some(handle.abort_handle());
}

/// Auto-pull (gọi lúc khởi động + định kỳ). Trả về trạng thái để UI hiển thị.
#[tauri::command]
pub async fn sync_auto_pull(app: AppHandle, state: State<'_, AppState>) -> R<String> {
    if keychain::get_secret(SYNC_AUTO).map_err(e)?.as_deref() != Some("1") {
        return Ok("disabled".into());
    }
    let (master, pat, repo) = match (
        keychain::get_secret(SYNC_MASTER).map_err(e)?,
        keychain::get_secret(SYNC_PAT).map_err(e)?,
        keychain::get_secret(SYNC_REPO).map_err(e)?,
    ) {
        (Some(m), Some(p), Some(r)) => (m, p, r),
        _ => return Ok("disabled".into()),
    };
    let (owner, r) = sync::parse_repo(&repo).map_err(e)?;
    let dirty = state.dirty.load(std::sync::atomic::Ordering::Relaxed);
    match do_pull(&state.db, &master, &pat, &owner, &r, dirty, false).await.map_err(e)? {
        PullOutcome::UpToDate => Ok("uptodate".into()),
        PullOutcome::Pulled => {
            state.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
            let _ = app.emit("sync:pulled", ());
            Ok("pulled".into())
        }
        PullOutcome::Conflict => {
            let _ = app.emit("sync:conflict", ());
            Ok("conflict".into())
        }
    }
}

/// Giải quyết conflict: "local" = giữ máy này (đẩy đè remote); "remote" = lấy remote (bỏ thay đổi local).
#[tauri::command]
pub async fn sync_resolve_conflict(app: AppHandle, state: State<'_, AppState>, choice: String) -> R<String> {
    let master = keychain::get_secret(SYNC_MASTER)
        .map_err(e)?
        .ok_or_else(|| "Auto-sync master password not set".to_string())?;
    let (pat, owner, repo) = sync_creds()?;
    if choice == "local" {
        match do_push(&state.db, &master, &pat, &owner, &repo, true).await.map_err(e)? {
            PushOutcome::Pushed(_) => {
                state.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
                Ok("kept-local".into())
            }
            PushOutcome::Conflict => Ok("conflict".into()),
        }
    } else {
        do_pull(&state.db, &master, &pat, &owner, &repo, false, true).await.map_err(e)?;
        state.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
        let _ = app.emit("sync:pulled", ());
        Ok("used-remote".into())
    }
}

#[tauri::command]
pub async fn sync_save_config(
    _state: State<'_, AppState>,
    pat: Option<String>,
    repo: String,
) -> R<()> {
    keychain::set_secret(SYNC_REPO, &repo).map_err(e)?;
    if let Some(p) = pat {
        if !p.is_empty() {
            keychain::set_secret(SYNC_PAT, &p).map_err(e)?;
        }
    }
    Ok(())
}

fn sync_creds() -> R<(String, String, String)> {
    let pat = keychain::get_secret(SYNC_PAT)
        .map_err(e)?
        .ok_or_else(|| "GitHub token not saved".to_string())?;
    let repo = keychain::get_secret(SYNC_REPO)
        .map_err(e)?
        .ok_or_else(|| "Repo not saved".to_string())?;
    let (owner, r) = sync::parse_repo(&repo).map_err(e)?;
    Ok((pat, owner, r))
}

#[tauri::command]
pub async fn sync_push(state: State<'_, AppState>, master: String) -> R<String> {
    let (pat, owner, repo) = sync_creds()?;
    match do_push(&state.db, &master, &pat, &owner, &repo, true).await.map_err(e)? {
        PushOutcome::Pushed(msg) => {
            state.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
            Ok(msg)
        }
        PushOutcome::Conflict => Err("Remote changed — conflict".into()),
    }
}

#[tauri::command]
pub async fn sync_pull(state: State<'_, AppState>, master: String) -> R<String> {
    let (pat, owner, repo) = sync_creds()?;
    // Pull tay = lấy remote (force), kể cả khi trùng sha (khôi phục lại).
    let Some((content_b64, sha)) = sync::get_vault(&pat, &owner, &repo).await.map_err(e)? else {
        return Err("No vault.enc in repo yet (never backed up?)".into());
    };
    let enc = base64::engine::general_purpose::STANDARD
        .decode(content_b64.as_bytes())
        .map_err(e)?;
    let json = sync::decrypt(&enc, &master).map_err(e)?;
    let vault: sync::Vault = serde_json::from_slice(&json).map_err(e)?;
    db::import_all(
        &state.db,
        &vault.hosts,
        &vault.groups,
        &vault.keys,
        &vault.tunnels,
        &vault.entries,
        &vault.folders,
        &vault.buckets,
    )
    .await
    .map_err(e)?;
    for (acc, val) in &vault.secrets {
        keychain::set_secret(acc, val).map_err(e)?;
    }
    set_last_sha(&sha);
    state.dirty.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(format!(
        "Restored {} hosts, {} keys, {} tunnels",
        vault.hosts.len(),
        vault.keys.len(),
        vault.tunnels.len()
    ))
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, endpoint: String) -> R<()> {
    state.sftp.close(&endpoint).await;
    Ok(())
}

#[tauri::command]
pub async fn fs_list(
    state: State<'_, AppState>,
    endpoint: String,
    path: String,
) -> R<Vec<FileEntry>> {
    state.sftp.list(&endpoint, &path).await.map_err(e)
}

#[tauri::command]
pub async fn fs_home(state: State<'_, AppState>, endpoint: String) -> R<String> {
    state.sftp.home(&endpoint).await.map_err(e)
}

#[tauri::command]
pub async fn fs_mkdir(state: State<'_, AppState>, endpoint: String, path: String) -> R<()> {
    state.sftp.mkdir(&endpoint, &path).await.map_err(e)
}

#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    endpoint: String,
    from: String,
    to: String,
) -> R<()> {
    state.sftp.rename(&endpoint, &from, &to).await.map_err(e)
}

#[tauri::command]
pub async fn fs_delete(
    state: State<'_, AppState>,
    endpoint: String,
    path: String,
    is_dir: bool,
) -> R<()> {
    state.sftp.remove(&endpoint, &path, is_dir).await.map_err(e)
}

#[tauri::command]
pub async fn sftp_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    src_endpoint: String,
    src_path: String,
    dst_endpoint: String,
    dst_path: String,
) -> R<String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    state.sftp.clone().spawn_transfer(
        app,
        job_id.clone(),
        src_endpoint,
        src_path,
        dst_endpoint,
        dst_path,
    );
    Ok(job_id)
}

#[tauri::command]
pub async fn ssh_send(state: State<'_, AppState>, id: String, data: String) -> R<()> {
    state.ssh.send(&id, data.into_bytes()).await.map_err(e)
}

#[tauri::command]
pub async fn ssh_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> R<()> {
    state.ssh.resize(&id, cols, rows).await.map_err(e)
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> R<()> {
    state.ssh.disconnect(&id).await.map_err(e)
}

