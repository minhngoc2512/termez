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
                Ok(AuthMethod::Key { pem, passphrase: None })
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
    if host.auth_type == "password" {
        if let Some(pw) = password {
            if !pw.is_empty() {
                keychain::set_secret(&keychain::host_password(&host.id), &pw).map_err(e)?;
            }
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

#[tauri::command]
pub async fn delete_host(app: AppHandle, state: State<'_, AppState>, id: String) -> R<()> {
    keychain::delete_secret(&keychain::host_password(&id)).ok();
    keychain::delete_secret(&keychain::proxy_password(&id)).ok();
    db::delete_host(&state.db, &id).await.map_err(e)?;
    schedule_autosync(app, &state);
    Ok(())
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
    state
        .ssh
        .connect(
            app,
            host.address,
            host.port as u16,
            host.username,
            auth,
            cols,
            rows,
            host.startup_snippet,
            host.keepalive != 0,
            proxy,
            jump,
        )
        .await
        .map_err(e)
}

// ----- SFTP -----

/// Mở SFTP tới server, trả về thư mục home.
#[tauri::command]
pub async fn sftp_open(state: State<'_, AppState>, host_id: String) -> R<String> {
    let host = db::get_host(&state.db, &host_id).await.map_err(e)?;
    let auth = resolve_auth(&host)?;
    let proxy = resolve_proxy(&host)?;
    let jump = resolve_jump(&state.db, &host, 0).await?;
    state
        .sftp
        .ensure_open(&host.id, &host.address, host.port as u16, &host.username, auth, proxy, jump)
        .await
        .map_err(e)
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

#[derive(serde::Serialize)]
pub struct AppLockStatus {
    enabled: bool,
    timeout_mins: u32,
}

#[tauri::command]
pub async fn applock_status() -> R<AppLockStatus> {
    let enabled = keychain::get_secret(APPLOCK).map_err(e)?.is_some();
    let timeout_mins = keychain::get_secret(APPLOCK_TIMEOUT)
        .map_err(e)?
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok(AppLockStatus { enabled, timeout_mins })
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

#[derive(serde::Deserialize)]
struct ImportedEntry {
    title: String,
    username: Option<String>,
    password: Option<String>,
    url: Option<String>,
    notes: Option<String>,
    totp: Option<String>,
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
        let input = VaultEntryInput {
            id: Some(id.clone()),
            title: it.title,
            username: it.username,
            url: it.url,
            notes: it.notes,
            tags: None,
            folder: Some("Imported".into()),
            linked_host_id: None,
            password: None,
            totp_secret: None,
        };
        db::upsert_entry(&state.db, &input, &id, has_totp).await.map_err(e)?;
        count += 1;
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

/// Gom vault + mã hóa + đẩy lên GitHub. Dùng chung cho backup tay và auto.
async fn build_and_push(
    db: &SqlitePool,
    master: &str,
    pat: &str,
    owner: &str,
    repo: &str,
) -> anyhow::Result<String> {
    let hosts = db::list_hosts(db).await?;
    let groups = db::list_groups(db).await?;
    let keys = db::list_keys(db).await?;
    let tunnels = db::list_tunnels(db).await?;
    let entries = db::list_entries(db).await?;
    let folders = db::list_vault_folders(db).await?;

    let mut secrets = std::collections::HashMap::new();
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

    let vault = sync::Vault { version: 1, hosts, groups, keys, tunnels, entries, folders, secrets };
    let json = serde_json::to_vec(&vault)?;
    let enc = sync::encrypt(&json, master)?;
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(&enc);
    let sha = sync::get_vault(pat, owner, repo).await?.map(|(_, sha)| sha);
    sync::put_vault(pat, owner, repo, &content_b64, sha, "Termez vault update").await?;
    Ok(format!(
        "Pushed {} hosts, {} keys, {} tunnels",
        vault.hosts.len(),
        vault.keys.len(),
        vault.tunnels.len()
    ))
}

/// Lên lịch auto-backup (debounce 3s) sau mỗi thay đổi dữ liệu.
pub fn schedule_autosync(app: AppHandle, state: &AppState) {
    if keychain::get_secret(SYNC_AUTO).ok().flatten().as_deref() != Some("1") {
        return;
    }
    let pool = state.db.clone();
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
        let (ok, message) = match build_and_push(&pool, &master, &pat, &owner, &r).await {
            Ok(m) => (true, m),
            Err(e) => (false, e.to_string()),
        };
        let _ = app.emit("sync:auto", serde_json::json!({ "ok": ok, "message": message }));
    });
    *guard = Some(handle.abort_handle());
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
    build_and_push(&state.db, &master, &pat, &owner, &repo)
        .await
        .map_err(e)
}

#[tauri::command]
pub async fn sync_pull(state: State<'_, AppState>, master: String) -> R<String> {
    let (pat, owner, repo) = sync_creds()?;

    let (content_b64, _sha) = sync::get_vault(&pat, &owner, &repo)
        .await
        .map_err(e)?
        .ok_or_else(|| "No vault.enc in repo yet (never backed up?)".to_string())?;
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
    )
    .await
    .map_err(e)?;
    for (acc, val) in &vault.secrets {
        keychain::set_secret(acc, val).map_err(e)?;
    }

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

