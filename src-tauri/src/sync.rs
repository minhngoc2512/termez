//! Cloud sync qua GitHub: gom toàn bộ dữ liệu + secret → mã hóa E2E (Argon2id +
//! XChaCha20-Poly1305) bằng master password → đẩy `vault.enc` lên repo GitHub private.
//! GitHub chỉ thấy ciphertext; cần master password mới giải mã được (zero-knowledge).

use crate::db::{Group, Host, SshKey, StorageBucket, Tunnel, VaultEntry};
use argon2::Argon2;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const VAULT_PATH: &str = "vault.enc";
const MAGIC: &[u8; 4] = b"TZV1";

/// Toàn bộ dữ liệu đồng bộ (secret gom từ keychain vào `secrets`).
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
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
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("khởi tạo cipher thất bại"))?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(&XNonce::from(nonce), plaintext)
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
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("khởi tạo cipher thất bại"))?;
    let nonce = XNonce::try_from(nonce).map_err(|_| anyhow::anyhow!("nonce không hợp lệ"))?;
    cipher
        .decrypt(&nonce, ct)
        .map_err(|_| anyhow::anyhow!("sai master password hoặc dữ liệu hỏng"))
}

// ---------- 3-way merge theo từng record ----------

/// Bản ghi có id để merge; `ts()` = updated_at (0 nếu loại đó chưa có timestamp).
trait Record: Clone + PartialEq {
    fn rid(&self) -> &str;
    fn ts(&self) -> i64 {
        0
    }
}
impl Record for Host {
    fn rid(&self) -> &str {
        &self.id
    }
    fn ts(&self) -> i64 {
        self.updated_at
    }
}
impl Record for VaultEntry {
    fn rid(&self) -> &str {
        &self.id
    }
    fn ts(&self) -> i64 {
        self.updated_at
    }
}
impl Record for Group {
    fn rid(&self) -> &str {
        &self.id
    }
}
impl Record for SshKey {
    fn rid(&self) -> &str {
        &self.id
    }
}
impl Record for Tunnel {
    fn rid(&self) -> &str {
        &self.id
    }
}
impl Record for StorageBucket {
    fn rid(&self) -> &str {
        &self.id
    }
}

/// Merge 3-way một danh sách record theo id.
/// base = tổ tiên chung; local/remote = hai phía. Ghi id xung đột (sửa 2 nơi) vào `conflicts`.
fn merge_vec<T: Record>(base: &[T], local: &[T], remote: &[T], conflicts: &mut Vec<String>) -> Vec<T> {
    use std::collections::BTreeMap;
    let bi: BTreeMap<&str, &T> = base.iter().map(|x| (x.rid(), x)).collect();
    let li: BTreeMap<&str, &T> = local.iter().map(|x| (x.rid(), x)).collect();
    let ri: BTreeMap<&str, &T> = remote.iter().map(|x| (x.rid(), x)).collect();

    let mut ids: Vec<&str> = bi.keys().chain(li.keys()).chain(ri.keys()).copied().collect();
    ids.sort_unstable();
    ids.dedup();

    let mut out = Vec::new();
    for id in ids {
        let b = bi.get(id).copied();
        let l = li.get(id).copied();
        let r = ri.get(id).copied();
        match (l, r) {
            (Some(l), Some(r)) => {
                if l == r {
                    out.push(l.clone());
                    continue;
                }
                let l_changed = b.map_or(true, |b| b != l);
                let r_changed = b.map_or(true, |b| b != r);
                if l_changed && !r_changed {
                    out.push(l.clone());
                } else if r_changed && !l_changed {
                    out.push(r.clone());
                } else {
                    // Sửa ở cả hai → bản mới hơn thắng (tie → local). Ghi nhận xung đột.
                    conflicts.push(id.to_string());
                    out.push(if r.ts() > l.ts() { r.clone() } else { l.clone() });
                }
            }
            (Some(l), None) => {
                // Không có ở remote: xoá ở remote hay mới thêm ở local?
                if b.is_some() {
                    if b != Some(l) {
                        // Sửa ở local nhưng xoá ở remote → giữ bản sửa (an toàn), ghi nhận.
                        conflicts.push(id.to_string());
                        out.push(l.clone());
                    } // else: không đổi + xoá ở remote → bỏ (tôn trọng xoá)
                } else {
                    out.push(l.clone()); // thêm mới ở local
                }
            }
            (None, Some(r)) => {
                if b.is_some() {
                    if b != Some(r) {
                        conflicts.push(id.to_string());
                        out.push(r.clone()); // sửa ở remote vs xoá ở local → giữ bản sửa
                    } // else: xoá ở local + remote không đổi → bỏ
                } else {
                    out.push(r.clone()); // thêm mới ở remote
                }
            }
            (None, None) => {} // đã xoá cả hai / không tồn tại
        }
    }
    out
}

/// Merge tập folder (chuỗi path). Tôn trọng cả thêm lẫn xoá.
fn merge_folders(base: &[String], local: &[String], remote: &[String]) -> Vec<String> {
    use std::collections::BTreeSet;
    let bs: BTreeSet<&str> = base.iter().map(|s| s.as_str()).collect();
    let ls: BTreeSet<&str> = local.iter().map(|s| s.as_str()).collect();
    let rs: BTreeSet<&str> = remote.iter().map(|s| s.as_str()).collect();
    let mut out: BTreeSet<&str> = ls.union(&rs).copied().collect();
    // Xoá folder có trong base nhưng bị bỏ ở ít nhất một phía (tôn trọng xoá).
    for f in &bs {
        if !ls.contains(f) || !rs.contains(f) {
            out.remove(f);
        }
    }
    out.into_iter().map(String::from).collect()
}

/// Merge map secret theo key (không có timestamp → tie ưu tiên local).
fn merge_secrets(
    base: &HashMap<String, String>,
    local: &HashMap<String, String>,
    remote: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut keys: Vec<&str> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .map(|s| s.as_str())
        .collect();
    keys.sort_unstable();
    keys.dedup();
    let mut out = HashMap::new();
    for k in keys {
        let b = base.get(k);
        let l = local.get(k);
        let r = remote.get(k);
        match (l, r) {
            (Some(l), Some(r)) => {
                if l == r || b == Some(l) {
                    out.insert(k.to_string(), r.clone()); // remote đổi hoặc bằng nhau
                } else {
                    out.insert(k.to_string(), l.clone()); // local đổi (hoặc cả hai → ưu tiên local)
                }
            }
            (Some(l), None) => {
                if b.is_none() || b != Some(l) {
                    out.insert(k.to_string(), l.clone()); // thêm/sửa ở local (giữ)
                } // else: xoá ở remote → bỏ
            }
            (None, Some(r)) => {
                if b.is_none() || b != Some(r) {
                    out.insert(k.to_string(), r.clone());
                }
            }
            (None, None) => {}
        }
    }
    out
}

/// Merge 3-way toàn bộ Vault. base = trạng thái lần đồng bộ trước (rỗng nếu chưa có).
/// `conflicts` gom id các record bị sửa cả hai phía (đã tự resolve) — hiện chỉ dùng
/// để bỏ qua, nhưng vẫn thu thập sẵn cho tương lai.
pub fn merge_vaults(base: &Vault, local: &Vault, remote: &Vault) -> Vault {
    let mut conflicts = Vec::new();
    Vault {
        version: local.version.max(remote.version).max(1),
        hosts: merge_vec(&base.hosts, &local.hosts, &remote.hosts, &mut conflicts),
        groups: merge_vec(&base.groups, &local.groups, &remote.groups, &mut conflicts),
        keys: merge_vec(&base.keys, &local.keys, &remote.keys, &mut conflicts),
        tunnels: merge_vec(&base.tunnels, &local.tunnels, &remote.tunnels, &mut conflicts),
        entries: merge_vec(&base.entries, &local.entries, &remote.entries, &mut conflicts),
        buckets: merge_vec(&base.buckets, &local.buckets, &remote.buckets, &mut conflicts),
        folders: merge_folders(&base.folders, &local.folders, &remote.folders),
        secrets: merge_secrets(&base.secrets, &local.secrets, &remote.secrets),
    }
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
) -> anyhow::Result<String> {
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
    // Trả về sha mới của file (để làm mốc đồng bộ).
    let j: serde_json::Value = resp.json().await.unwrap_or_default();
    Ok(j["content"]["sha"].as_str().unwrap_or("").to_string())
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

    // ---- merge 3-way ----
    #[derive(Clone, PartialEq, Debug)]
    struct Rec {
        id: String,
        v: i32,
        t: i64,
    }
    impl Record for Rec {
        fn rid(&self) -> &str {
            &self.id
        }
        fn ts(&self) -> i64 {
            self.t
        }
    }
    fn rec(id: &str, v: i32, t: i64) -> Rec {
        Rec { id: id.into(), v, t }
    }
    fn ids(v: &[Rec]) -> Vec<(&str, i32)> {
        let mut o: Vec<(&str, i32)> = v.iter().map(|r| (r.id.as_str(), r.v)).collect();
        o.sort();
        o
    }

    #[test]
    fn merge_adds_from_both_sides() {
        let base: Vec<Rec> = vec![];
        let local = vec![rec("a", 1, 1)];
        let remote = vec![rec("b", 1, 1)];
        let mut c = vec![];
        let out = merge_vec(&base, &local, &remote, &mut c);
        assert_eq!(ids(&out), vec![("a", 1), ("b", 1)]);
        assert!(c.is_empty());
    }

    #[test]
    fn merge_one_sided_edit_wins_without_conflict() {
        let base = vec![rec("a", 1, 1)];
        let local = vec![rec("a", 2, 2)]; // sửa ở local
        let remote = vec![rec("a", 1, 1)]; // remote không đổi
        let mut c = vec![];
        let out = merge_vec(&base, &local, &remote, &mut c);
        assert_eq!(ids(&out), vec![("a", 2)]);
        assert!(c.is_empty());
    }

    #[test]
    fn merge_both_edited_newer_ts_wins_and_reports() {
        let base = vec![rec("a", 1, 1)];
        let local = vec![rec("a", 2, 5)];
        let remote = vec![rec("a", 3, 9)]; // mới hơn
        let mut c = vec![];
        let out = merge_vec(&base, &local, &remote, &mut c);
        assert_eq!(ids(&out), vec![("a", 3)]);
        assert_eq!(c, vec!["a".to_string()]);
    }

    #[test]
    fn merge_honors_delete() {
        let base = vec![rec("a", 1, 1), rec("b", 1, 1)];
        let local = vec![rec("a", 1, 1)]; // xoá b ở local
        let remote = vec![rec("a", 1, 1), rec("b", 1, 1)]; // remote giữ b, không đổi
        let mut c = vec![];
        let out = merge_vec(&base, &local, &remote, &mut c);
        assert_eq!(ids(&out), vec![("a", 1)]); // b bị xoá
        assert!(c.is_empty());
    }

    #[test]
    fn merge_edit_vs_delete_keeps_edit() {
        let base = vec![rec("a", 1, 1)];
        let local = vec![rec("a", 5, 9)]; // sửa ở local
        let remote: Vec<Rec> = vec![]; // xoá ở remote
        let mut c = vec![];
        let out = merge_vec(&base, &local, &remote, &mut c);
        assert_eq!(ids(&out), vec![("a", 5)]);
        assert_eq!(c, vec!["a".to_string()]);
    }

    #[test]
    fn merge_folders_add_and_delete() {
        let base = vec!["k".to_string(), "gone".to_string()];
        let local = vec!["k".to_string(), "L".to_string()]; // thêm L, xoá gone
        let remote = vec!["k".to_string(), "gone".to_string(), "R".to_string()]; // thêm R
        let mut out = merge_folders(&base, &local, &remote);
        out.sort();
        assert_eq!(out, vec!["L".to_string(), "R".to_string(), "k".to_string()]);
    }
}
