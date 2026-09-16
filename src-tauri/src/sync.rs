//! Cloud sync qua GitHub: gom toàn bộ dữ liệu + secret → mã hóa E2E (Argon2id +
//! XChaCha20-Poly1305) bằng master password → đẩy `vault.enc` lên repo GitHub private.
//! GitHub chỉ thấy ciphertext; cần master password mới giải mã được (zero-knowledge).

use crate::db::{Group, Host, SshKey, StorageBucket, Tunnel, VaultEntry};
use argon2::Argon2;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const VAULT_PATH: &str = "vault.enc";
const MAGIC: &[u8; 4] = b"TZV1";

/// Toàn bộ dữ liệu đồng bộ (secret gom từ keychain vào `secrets`).
#[derive(Serialize, Deserialize)]
pub struct Vault {
    pub version: u32,
    pub hosts: Vec<Host>,
    pub groups: Vec<Group>,
    pub keys: Vec<SshKey>,
    pub tunnels: Vec<Tunnel>,
    #[serde(default)]
    pub entries: Vec<VaultEntry>,
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub buckets: Vec<StorageBucket>,
    /// account keychain -> giá trị (mật khẩu host, private key, passphrase, proxy pass…)
    pub secrets: HashMap<String, String>,
}

// ---------- Crypto ----------

fn derive_key(master: &str, salt: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(master.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("Argon2 lỗi: {e}"))?;
    Ok(key)
}

/// Mã hóa: envelope = MAGIC(4) | salt(16) | nonce(24) | ciphertext.
pub fn encrypt(plaintext: &[u8], master: &str) -> anyhow::Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = derive_key(master, &salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| anyhow::anyhow!("mã hóa thất bại"))?;
    let mut out = Vec::with_capacity(4 + 16 + 24 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

pub fn decrypt(data: &[u8], master: &str) -> anyhow::Result<Vec<u8>> {
    if data.len() < 4 + 16 + 24 || &data[..4] != MAGIC {
        anyhow::bail!("vault không hợp lệ");
    }
    let salt = &data[4..20];
    let nonce = &data[20..44];
    let ct = &data[44..];
    let key = derive_key(master, salt)?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key));
    cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| anyhow::anyhow!("sai master password hoặc dữ liệu hỏng"))
}

// ---------- GitHub Contents API ----------

/// Tách "owner/repo".
pub fn parse_repo(repo: &str) -> anyhow::Result<(String, String)> {
    let mut it = repo.trim().splitn(2, '/');
    match (it.next(), it.next()) {
        (Some(o), Some(r)) if !o.is_empty() && !r.is_empty() => Ok((o.to_string(), r.to_string())),
        _ => anyhow::bail!("repo phải dạng owner/repo"),
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Lấy vault.enc: trả về (nội dung file base64 GitHub, sha) hoặc None nếu chưa có.
pub async fn get_vault(
    pat: &str,
    owner: &str,
    repo: &str,
) -> anyhow::Result<Option<(String, String)>> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/contents/{VAULT_PATH}");
    let resp = client()
        .get(&url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("User-Agent", "Termez")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        let s = resp.status();
        anyhow::bail!("GitHub GET lỗi {}: {}", s, resp.text().await.unwrap_or_default());
    }
    let j: serde_json::Value = resp.json().await?;
    let content = j["content"].as_str().unwrap_or("").replace(['\n', '\r'], "");
    let sha = j["sha"].as_str().unwrap_or("").to_string();
    Ok(Some((content, sha)))
}

/// Đẩy vault.enc (tạo hoặc cập nhật). `content_b64` là base64 của bytes file.
pub async fn put_vault(
    pat: &str,
    owner: &str,
    repo: &str,
    content_b64: &str,
    sha: Option<String>,
    message: &str,
) -> anyhow::Result<()> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/contents/{VAULT_PATH}");
    let mut body = serde_json::json!({ "message": message, "content": content_b64 });
    if let Some(s) = sha {
        body["sha"] = serde_json::Value::String(s);
    }
    let resp = client()
        .put(&url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("User-Agent", "Termez")
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let s = resp.status();
        anyhow::bail!("GitHub PUT lỗi {}: {}", s, resp.text().await.unwrap_or_default());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crypto_roundtrip() {
        let data = b"hosts + secrets json";
        let enc = encrypt(data, "correct horse battery").unwrap();
        assert_ne!(&enc[4..], data); // đã mã hóa
        let dec = decrypt(&enc, "correct horse battery").unwrap();
        assert_eq!(dec, data);
        assert!(decrypt(&enc, "wrong password").is_err());
    }

    #[test]
    fn parse_repo_ok() {
        assert_eq!(parse_repo("me/vault").unwrap(), ("me".into(), "vault".into()));
        assert!(parse_repo("noslash").is_err());
    }
}
