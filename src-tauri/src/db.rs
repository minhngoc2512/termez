use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};
use std::path::Path;
use std::str::FromStr;

/// Nhóm host (cây, có thể lồng nhau qua `parent_id`).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
}

/// Một server SSH.
///
/// NOTE (bảo mật): `password` và `passphrase` hiện lưu plaintext trong SQLite cho MVP Phase 1.
/// Phase 2/5 sẽ chuyển sang OS keychain + vault mã hóa E2E.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Host {
    pub id: String,
    pub group_id: Option<String>,
    pub label: String,
    pub address: String,
    pub port: i64,
    pub username: String,
    /// 'password' | 'key' | 'agent'
    pub auth_type: String,
    /// Bí mật KHÔNG lưu ở đây — nằm trong OS keychain. Cột giữ NULL, chỉ còn để tương thích.
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    /// Tham chiếu tới managed key trong bảng `ssh_keys` (khi auth_type = 'key').
    pub key_id: Option<String>,
    /// Lệnh tự chạy khi vừa kết nối.
    pub startup_snippet: Option<String>,
    /// 0/1: bật keepalive giữ kết nối.
    pub keepalive: i64,
    /// Tên preset theme terminal riêng cho host (nullable = mặc định).
    pub term_theme: Option<String>,
    pub font_size: Option<i64>,
    /// Proxy: 'socks5' | 'http' | NULL (không dùng). Mật khẩu proxy lưu keychain.
    pub proxy_type: Option<String>,
    pub proxy_host: Option<String>,
    pub proxy_port: Option<i64>,
    pub proxy_username: Option<String>,
    /// Jump host (bastion): tham chiếu tới host khác dùng làm ProxyJump.
    pub jump_host_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// SSH key do app quản lý. Private key material nằm trong keychain, KHÔNG trong DB.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SshKey {
    pub id: String,
    pub name: String,
    /// 'ed25519' | 'rsa' | ...
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub has_passphrase: i64,
    pub created_at: i64,
}

/// Payload tạo/cập nhật host từ frontend (không có id khi tạo mới).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInput {
    pub id: Option<String>,
    pub group_id: Option<String>,
    pub label: String,
    pub address: String,
    pub port: i64,
    pub username: String,
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
    pub key_id: Option<String>,
    pub startup_snippet: Option<String>,
    pub keepalive: bool,
    pub term_theme: Option<String>,
    pub font_size: Option<i64>,
    pub proxy_type: Option<String>,
    pub proxy_host: Option<String>,
    pub proxy_port: Option<i64>,
    pub proxy_username: Option<String>,
    pub jump_host_id: Option<String>,
    /// mật khẩu proxy (chỉ khi tạo/sửa; lưu vào keychain, không vào DB)
    pub proxy_password: Option<String>,
}

fn now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Mở (tạo nếu chưa có) database SQLite tại `path` và chạy migration khởi tạo.
pub async fn init_pool(path: &Path) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            parent_id   TEXT,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS hosts (
            id                TEXT PRIMARY KEY,
            group_id          TEXT,
            label             TEXT NOT NULL,
            address           TEXT NOT NULL,
            port              INTEGER NOT NULL DEFAULT 22,
            username          TEXT NOT NULL,
            auth_type         TEXT NOT NULL DEFAULT 'password',
            password          TEXT,
            private_key_path  TEXT,
            passphrase        TEXT,
            key_id            TEXT,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS ssh_keys (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            algorithm      TEXT NOT NULL,
            public_key     TEXT NOT NULL,
            fingerprint    TEXT NOT NULL,
            has_passphrase INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS tunnels (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            host_id      TEXT NOT NULL,
            kind         TEXT NOT NULL,
            local_port   INTEGER NOT NULL,
            remote_host  TEXT,
            remote_port  INTEGER,
            created_at   INTEGER NOT NULL
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS vault_entries (
            id             TEXT PRIMARY KEY,
            title          TEXT NOT NULL,
            username       TEXT,
            url            TEXT,
            notes          TEXT,
            tags           TEXT,
            folder         TEXT,
            linked_host_id TEXT,
            has_totp       INTEGER NOT NULL DEFAULT 0,
            created_at     INTEGER NOT NULL,
            updated_at     INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vault_folders (
            path        TEXT PRIMARY KEY,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS storage_buckets (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            endpoint    TEXT NOT NULL,
            region      TEXT,
            access_key  TEXT NOT NULL,
            bucket      TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS known_hosts (
            id          TEXT PRIMARY KEY,
            host        TEXT NOT NULL,
            port        INTEGER NOT NULL,
            key_type    TEXT NOT NULL,
            key_b64     TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            added_at    INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ix_known_hosts_hp ON known_hosts(host, port);
        "#,
    )
    .execute(pool)
    .await?;

    // Thêm cột cho DB cũ nếu thiếu (idempotent).
    let add_cols: &[(&str, &str)] = &[
        ("key_id", "TEXT"),
        ("startup_snippet", "TEXT"),
        ("keepalive", "INTEGER NOT NULL DEFAULT 0"),
        ("term_theme", "TEXT"),
        ("font_size", "INTEGER"),
        ("proxy_type", "TEXT"),
        ("proxy_host", "TEXT"),
        ("proxy_port", "INTEGER"),
        ("proxy_username", "TEXT"),
        ("jump_host_id", "TEXT"),
    ];
    for (name, ty) in add_cols {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM pragma_table_info('hosts') WHERE name = ?")
                .bind(name)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            sqlx::query(&format!("ALTER TABLE hosts ADD COLUMN {name} {ty}"))
                .execute(pool)
                .await?;
        }
    }

    Ok(())
}

// ----- Groups -----

pub async fn list_groups(pool: &SqlitePool) -> anyhow::Result<Vec<Group>> {
    let rows = sqlx::query_as::<_, Group>("SELECT * FROM groups ORDER BY name COLLATE NOCASE")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn create_group(
    pool: &SqlitePool,
    name: &str,
    parent_id: Option<String>,
) -> anyhow::Result<Group> {
    let g = Group {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        parent_id,
        created_at: now(),
    };
    sqlx::query("INSERT INTO groups (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)")
        .bind(&g.id)
        .bind(&g.name)
        .bind(&g.parent_id)
        .bind(g.created_at)
        .execute(pool)
        .await?;
    Ok(g)
}

pub async fn delete_group(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    // Gỡ liên kết host thuộc group rồi xóa group.
    sqlx::query("UPDATE hosts SET group_id = NULL WHERE group_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM groups WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Hosts -----

pub async fn list_hosts(pool: &SqlitePool) -> anyhow::Result<Vec<Host>> {
    let rows = sqlx::query_as::<_, Host>("SELECT * FROM hosts ORDER BY label COLLATE NOCASE")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn get_host(pool: &SqlitePool, id: &str) -> anyhow::Result<Host> {
    let row = sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn upsert_host(pool: &SqlitePool, input: HostInput) -> anyhow::Result<Host> {
    let ts = now();
    match input.id {
        Some(id) => {
            sqlx::query(
                r#"UPDATE hosts SET group_id=?, label=?, address=?, port=?, username=?,
                   auth_type=?, password=NULL, private_key_path=?, passphrase=NULL,
                   key_id=?, startup_snippet=?, keepalive=?, term_theme=?, font_size=?,
                   proxy_type=?, proxy_host=?, proxy_port=?, proxy_username=?,
                   jump_host_id=?, updated_at=?
                   WHERE id=?"#,
            )
            .bind(&input.group_id)
            .bind(&input.label)
            .bind(&input.address)
            .bind(input.port)
            .bind(&input.username)
            .bind(&input.auth_type)
            .bind(&input.private_key_path)
            .bind(&input.key_id)
            .bind(&input.startup_snippet)
            .bind(input.keepalive as i64)
            .bind(&input.term_theme)
            .bind(input.font_size)
            .bind(&input.proxy_type)
            .bind(&input.proxy_host)
            .bind(input.proxy_port)
            .bind(&input.proxy_username)
            .bind(&input.jump_host_id)
            .bind(ts)
            .bind(&id)
            .execute(pool)
            .await?;
            get_host(pool, &id).await
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                r#"INSERT INTO hosts (id, group_id, label, address, port, username, auth_type,
                   private_key_path, key_id, startup_snippet, keepalive, term_theme, font_size,
                   proxy_type, proxy_host, proxy_port, proxy_username, jump_host_id,
                   created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(&id)
            .bind(&input.group_id)
            .bind(&input.label)
            .bind(&input.address)
            .bind(input.port)
            .bind(&input.username)
            .bind(&input.auth_type)
            .bind(&input.private_key_path)
            .bind(&input.key_id)
            .bind(&input.startup_snippet)
            .bind(input.keepalive as i64)
            .bind(&input.term_theme)
            .bind(input.font_size)
            .bind(&input.proxy_type)
            .bind(&input.proxy_host)
            .bind(input.proxy_port)
            .bind(&input.proxy_username)
            .bind(&input.jump_host_id)
            .bind(ts)
            .bind(ts)
            .execute(pool)
            .await?;
            get_host(pool, &id).await
        }
    }
}

pub async fn delete_host(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM hosts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- SSH keys -----

pub async fn list_keys(pool: &SqlitePool) -> anyhow::Result<Vec<SshKey>> {
    let rows = sqlx::query_as::<_, SshKey>("SELECT * FROM ssh_keys ORDER BY name COLLATE NOCASE")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn get_key(pool: &SqlitePool, id: &str) -> anyhow::Result<SshKey> {
    let row = sqlx::query_as::<_, SshKey>("SELECT * FROM ssh_keys WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn insert_key(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    algorithm: &str,
    public_key: &str,
    fingerprint: &str,
    has_passphrase: bool,
) -> anyhow::Result<SshKey> {
    sqlx::query(
        r#"INSERT INTO ssh_keys (id, name, algorithm, public_key, fingerprint, has_passphrase, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(id)
    .bind(name)
    .bind(algorithm)
    .bind(public_key)
    .bind(fingerprint)
    .bind(has_passphrase as i64)
    .bind(now())
    .execute(pool)
    .await?;
    get_key(pool, id).await
}

pub async fn delete_key(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    // Gỡ liên kết host đang dùng key này.
    sqlx::query("UPDATE hosts SET key_id = NULL WHERE key_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM ssh_keys WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Tunnels (port forwarding) -----

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Tunnel {
    pub id: String,
    pub name: String,
    pub host_id: String,
    /// 'local' | 'remote' | 'dynamic'
    pub kind: String,
    pub local_port: i64,
    pub remote_host: Option<String>,
    pub remote_port: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelInput {
    pub id: Option<String>,
    pub name: String,
    pub host_id: String,
    pub kind: String,
    pub local_port: i64,
    pub remote_host: Option<String>,
    pub remote_port: Option<i64>,
}

pub async fn list_tunnels(pool: &SqlitePool) -> anyhow::Result<Vec<Tunnel>> {
    let rows = sqlx::query_as::<_, Tunnel>("SELECT * FROM tunnels ORDER BY name COLLATE NOCASE")
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn get_tunnel(pool: &SqlitePool, id: &str) -> anyhow::Result<Tunnel> {
    let row = sqlx::query_as::<_, Tunnel>("SELECT * FROM tunnels WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn upsert_tunnel(pool: &SqlitePool, input: TunnelInput) -> anyhow::Result<Tunnel> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    sqlx::query(
        r#"INSERT INTO tunnels (id, name, host_id, kind, local_port, remote_host, remote_port, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, host_id=excluded.host_id,
             kind=excluded.kind, local_port=excluded.local_port,
             remote_host=excluded.remote_host, remote_port=excluded.remote_port"#,
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.host_id)
    .bind(&input.kind)
    .bind(input.local_port)
    .bind(&input.remote_host)
    .bind(input.remote_port)
    .bind(now())
    .execute(pool)
    .await?;
    get_tunnel(pool, &id).await
}

pub async fn delete_tunnel(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM tunnels WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Password manager entries -----

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<String>,
    pub folder: Option<String>,
    pub linked_host_id: Option<String>,
    pub has_totp: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntryInput {
    pub id: Option<String>,
    pub title: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<String>,
    pub folder: Option<String>,
    pub linked_host_id: Option<String>,
    /// secret → keychain, không vào DB
    pub password: Option<String>,
    pub totp_secret: Option<String>,
}

pub async fn list_entries(pool: &SqlitePool) -> anyhow::Result<Vec<VaultEntry>> {
    let rows = sqlx::query_as::<_, VaultEntry>(
        "SELECT * FROM vault_entries ORDER BY title COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_entry(pool: &SqlitePool, id: &str) -> anyhow::Result<VaultEntry> {
    let row = sqlx::query_as::<_, VaultEntry>("SELECT * FROM vault_entries WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(row)
}

pub async fn upsert_entry(
    pool: &SqlitePool,
    input: &VaultEntryInput,
    id: &str,
    has_totp: bool,
) -> anyhow::Result<VaultEntry> {
    let ts = now();
    sqlx::query(
        r#"INSERT INTO vault_entries (id, title, username, url, notes, tags, folder,
           linked_host_id, has_totp, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, username=excluded.username,
             url=excluded.url, notes=excluded.notes, tags=excluded.tags, folder=excluded.folder,
             linked_host_id=excluded.linked_host_id, has_totp=excluded.has_totp,
             updated_at=excluded.updated_at"#,
    )
    .bind(id)
    .bind(&input.title)
    .bind(&input.username)
    .bind(&input.url)
    .bind(&input.notes)
    .bind(&input.tags)
    .bind(&input.folder)
    .bind(&input.linked_host_id)
    .bind(has_totp as i64)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;
    get_entry(pool, id).await
}

pub async fn delete_entry(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM vault_entries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Thư mục vault (cho phép thư mục rỗng + thư mục con dạng path "a/b/c") -----

pub async fn list_vault_folders(pool: &SqlitePool) -> anyhow::Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT path FROM vault_folders ORDER BY path COLLATE NOCASE")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(p,)| p).collect())
}

pub async fn create_vault_folder(pool: &SqlitePool, path: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT OR IGNORE INTO vault_folders (path, created_at) VALUES (?, ?)")
        .bind(path)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

/// Id của mọi entry trong thư mục `path` và các thư mục con (để dọn keychain khi xóa).
pub async fn entry_ids_in_folder(pool: &SqlitePool, path: &str) -> anyhow::Result<Vec<String>> {
    let like = format!("{path}/%");
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM vault_entries WHERE folder = ? OR folder LIKE ?")
            .bind(path)
            .bind(&like)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(x,)| x).collect())
}

/// Xóa một thư mục và mọi thư mục con (path bắt đầu bằng "folder/").
pub async fn delete_vault_folder(pool: &SqlitePool, path: &str) -> anyhow::Result<()> {
    let prefix = format!("{path}/%");
    sqlx::query("DELETE FROM vault_folders WHERE path = ? OR path LIKE ?")
        .bind(path)
        .bind(&prefix)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Kết nối lưu trữ S3/R2/MinIO -----

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct StorageBucket {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub region: Option<String>,
    pub access_key: String,
    pub bucket: String,
    pub created_at: i64,
}

#[derive(Deserialize)]
pub struct StorageBucketInput {
    pub id: Option<String>,
    pub name: String,
    pub endpoint: String,
    pub region: Option<String>,
    pub access_key: String,
    pub bucket: String,
    pub secret_key: Option<String>,
}

pub async fn list_buckets(pool: &SqlitePool) -> anyhow::Result<Vec<StorageBucket>> {
    Ok(sqlx::query_as::<_, StorageBucket>(
        "SELECT * FROM storage_buckets ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn get_bucket(pool: &SqlitePool, id: &str) -> anyhow::Result<StorageBucket> {
    Ok(sqlx::query_as::<_, StorageBucket>("SELECT * FROM storage_buckets WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?)
}

pub async fn upsert_bucket(
    pool: &SqlitePool,
    input: &StorageBucketInput,
    id: &str,
) -> anyhow::Result<StorageBucket> {
    sqlx::query(
        r#"INSERT INTO storage_buckets (id, name, endpoint, region, access_key, bucket, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name=excluded.name, endpoint=excluded.endpoint,
             region=excluded.region, access_key=excluded.access_key, bucket=excluded.bucket"#,
    )
    .bind(id)
    .bind(&input.name)
    .bind(&input.endpoint)
    .bind(&input.region)
    .bind(&input.access_key)
    .bind(&input.bucket)
    .bind(now())
    .execute(pool)
    .await?;
    get_bucket(pool, id).await
}

pub async fn delete_bucket(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM storage_buckets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ----- Known hosts (xác thực host key) -----

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct KnownHost {
    pub id: String,
    pub host: String,
    pub port: i64,
    pub key_type: String,
    pub key_b64: String,
    pub fingerprint: String,
    pub added_at: i64,
}

pub async fn list_known_hosts(pool: &SqlitePool) -> anyhow::Result<Vec<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>(
        "SELECT * FROM known_hosts ORDER BY host COLLATE NOCASE, port",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn get_known_host(pool: &SqlitePool, host: &str, port: u16) -> anyhow::Result<Option<KnownHost>> {
    Ok(sqlx::query_as::<_, KnownHost>("SELECT * FROM known_hosts WHERE host = ? AND port = ?")
        .bind(host)
        .bind(port as i64)
        .fetch_optional(pool)
        .await?)
}

pub async fn add_known_host(
    pool: &SqlitePool,
    host: &str,
    port: u16,
    key_type: &str,
    key_b64: &str,
    fingerprint: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        r#"INSERT INTO known_hosts (id, host, port, key_type, key_b64, fingerprint, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(host, port) DO UPDATE SET key_type=excluded.key_type,
             key_b64=excluded.key_b64, fingerprint=excluded.fingerprint, added_at=excluded.added_at"#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(host)
    .bind(port as i64)
    .bind(key_type)
    .bind(key_b64)
    .bind(fingerprint)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_known_host(pool: &SqlitePool, id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM known_hosts WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Đổi tên/đường dẫn thư mục: đổi cả bản ghi thư mục con và cập nhật entry (giữ prefix).
pub async fn rename_vault_folder(pool: &SqlitePool, old: &str, new: &str) -> anyhow::Result<()> {
    let old_like = format!("{old}/%");
    let new_prefix = format!("{new}/");
    // substr là 1-index theo ký tự → bỏ qua "old/" rồi ghép prefix mới.
    let skip = (format!("{old}/").chars().count() as i64) + 1;

    sqlx::query("UPDATE OR IGNORE vault_folders SET path = ? WHERE path = ?")
        .bind(new).bind(old).execute(pool).await?;
    sqlx::query("UPDATE OR IGNORE vault_folders SET path = ? || substr(path, ?) WHERE path LIKE ?")
        .bind(&new_prefix).bind(skip).bind(&old_like).execute(pool).await?;

    sqlx::query("UPDATE vault_entries SET folder = ? WHERE folder = ?")
        .bind(new).bind(old).execute(pool).await?;
    sqlx::query("UPDATE vault_entries SET folder = ? || substr(folder, ?) WHERE folder LIKE ?")
        .bind(&new_prefix).bind(skip).bind(&old_like).execute(pool).await?;
    Ok(())
}

// ----- Sync: nhập toàn bộ dữ liệu (khôi phục vault) -----

/// Xóa sạch rồi ghi lại toàn bộ từ vault. (Secret khôi phục riêng vào keychain.)
pub async fn import_all(
    pool: &SqlitePool,
    hosts: &[Host],
    groups: &[Group],
    keys: &[SshKey],
    tunnels: &[Tunnel],
    entries: &[VaultEntry],
    folders: &[String],
    buckets: &[StorageBucket],
) -> anyhow::Result<()> {
    for t in ["tunnels", "hosts", "ssh_keys", "groups", "vault_entries", "vault_folders", "storage_buckets"] {
        sqlx::query(&format!("DELETE FROM {t}")).execute(pool).await?;
    }
    for path in folders {
        sqlx::query("INSERT OR IGNORE INTO vault_folders (path, created_at) VALUES (?, ?)")
            .bind(path)
            .bind(now())
            .execute(pool)
            .await?;
    }
    for b in buckets {
        sqlx::query(
            "INSERT INTO storage_buckets (id, name, endpoint, region, access_key, bucket, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&b.id)
        .bind(&b.name)
        .bind(&b.endpoint)
        .bind(&b.region)
        .bind(&b.access_key)
        .bind(&b.bucket)
        .bind(b.created_at)
        .execute(pool)
        .await?;
    }
    for en in entries {
        sqlx::query(
            r#"INSERT INTO vault_entries (id, title, username, url, notes, tags, folder,
               linked_host_id, has_totp, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&en.id)
        .bind(&en.title)
        .bind(&en.username)
        .bind(&en.url)
        .bind(&en.notes)
        .bind(&en.tags)
        .bind(&en.folder)
        .bind(&en.linked_host_id)
        .bind(en.has_totp)
        .bind(en.created_at)
        .bind(en.updated_at)
        .execute(pool)
        .await?;
    }
    for g in groups {
        sqlx::query("INSERT INTO groups (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)")
            .bind(&g.id)
            .bind(&g.name)
            .bind(&g.parent_id)
            .bind(g.created_at)
            .execute(pool)
            .await?;
    }
    for k in keys {
        sqlx::query(
            "INSERT INTO ssh_keys (id, name, algorithm, public_key, fingerprint, has_passphrase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&k.id)
        .bind(&k.name)
        .bind(&k.algorithm)
        .bind(&k.public_key)
        .bind(&k.fingerprint)
        .bind(k.has_passphrase)
        .bind(k.created_at)
        .execute(pool)
        .await?;
    }
    for h in hosts {
        sqlx::query(
            r#"INSERT INTO hosts (id, group_id, label, address, port, username, auth_type,
               password, private_key_path, passphrase, key_id, startup_snippet, keepalive,
               term_theme, font_size, proxy_type, proxy_host, proxy_port, proxy_username,
               jump_host_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&h.id)
        .bind(&h.group_id)
        .bind(&h.label)
        .bind(&h.address)
        .bind(h.port)
        .bind(&h.username)
        .bind(&h.auth_type)
        .bind(&h.password)
        .bind(&h.private_key_path)
        .bind(&h.passphrase)
        .bind(&h.key_id)
        .bind(&h.startup_snippet)
        .bind(h.keepalive)
        .bind(&h.term_theme)
        .bind(h.font_size)
        .bind(&h.proxy_type)
        .bind(&h.proxy_host)
        .bind(h.proxy_port)
        .bind(&h.proxy_username)
        .bind(&h.jump_host_id)
        .bind(h.created_at)
        .bind(h.updated_at)
        .execute(pool)
        .await?;
    }
    for t in tunnels {
        sqlx::query(
            "INSERT INTO tunnels (id, name, host_id, kind, local_port, remote_host, remote_port, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&t.id)
        .bind(&t.name)
        .bind(&t.host_id)
        .bind(&t.kind)
        .bind(t.local_port)
        .bind(&t.remote_host)
        .bind(t.remote_port)
        .bind(t.created_at)
        .execute(pool)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn upsert_and_list_roundtrip() {
        let dir = std::env::temp_dir().join(format!("terminus-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pool = init_pool(&dir.join("t.db")).await.expect("init");

        let input = HostInput {
            id: None,
            group_id: None,
            label: "srv".into(),
            address: "1.2.3.4".into(),
            port: 22,
            username: "root".into(),
            auth_type: "password".into(),
            password: Some("secret".into()),
            private_key_path: None,
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
            proxy_password: None,
        };
        let saved = upsert_host(&pool, input).await.expect("upsert insert");
        assert_eq!(saved.label, "srv");

        let hosts = list_hosts(&pool).await.expect("list");
        assert_eq!(hosts.len(), 1, "phải có đúng 1 host sau khi thêm");
        assert_eq!(hosts[0].address, "1.2.3.4");

        std::fs::remove_dir_all(&dir).ok();
    }
}
