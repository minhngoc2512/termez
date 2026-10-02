//! Lưu secret (mật khẩu host, private key, passphrase) vào OS keychain
//! qua secret-service. Không bao giờ ghi plaintext vào SQLite.

use keyring::{Entry, Error};

// Namespace keychain giữ nguyên (không đổi theo tên app) để không mất secret đã lưu
// khi app đổi tên/identifier. Đây là chuỗi nội bộ, không hiển thị cho người dùng.
const SERVICE: &str = "com.terminus.app";

/// Credential Manager của Windows giới hạn mỗi secret 2560 byte UTF-16 (1280 ký tự) —
/// không đủ cho private key dài hay key JSON của service account Google. Secret dài
/// hơn được chia thành nhiều entry `<account>#<i>`; entry chính chỉ giữ dấu `CHUNKED`.
#[cfg(windows)]
const MAX_UNITS: usize = 1200;
#[cfg(not(windows))]
const MAX_UNITS: usize = usize::MAX;
const CHUNKED: &str = "\u{1}termez-chunks:";

fn chunk_account(account: &str, i: usize) -> String {
    format!("{account}#{i}")
}

pub fn set_secret(account: &str, secret: &str) -> anyhow::Result<()> {
    set_secret_split(account, secret, MAX_UNITS)
}

fn set_secret_split(account: &str, secret: &str, max_units: usize) -> anyhow::Result<()> {
    delete_chunks(account)?;
    let entry = Entry::new(SERVICE, account)?;
    if secret.encode_utf16().count() <= max_units {
        entry.set_password(secret)?;
        return Ok(());
    }
    let mut parts: Vec<String> = vec![String::new()];
    let mut units = 0;
    for c in secret.chars() {
        if units + c.len_utf16() > max_units {
            parts.push(String::new());
            units = 0;
        }
        units += c.len_utf16();
        parts.last_mut().unwrap().push(c);
    }
    for (i, p) in parts.iter().enumerate() {
        Entry::new(SERVICE, &chunk_account(account, i))?.set_password(p)?;
    }
    entry.set_password(&format!("{CHUNKED}{}", parts.len()))?;
    Ok(())
}

fn chunk_count(raw: &str) -> Option<usize> {
    raw.strip_prefix(CHUNKED)?.parse().ok()
}

pub fn get_secret(account: &str) -> anyhow::Result<Option<String>> {
    let entry = Entry::new(SERVICE, account)?;
    let raw = match entry.get_password() {
        Ok(s) => s,
        Err(Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let Some(n) = chunk_count(&raw) else { return Ok(Some(raw)) };
    let mut out = String::new();
    for i in 0..n {
        out.push_str(&Entry::new(SERVICE, &chunk_account(account, i))?.get_password()?);
    }
    Ok(Some(out))
}

/// Xoá các entry phụ của secret đã chia nhỏ (nếu có).
fn delete_chunks(account: &str) -> anyhow::Result<()> {
    let raw = match Entry::new(SERVICE, account)?.get_password() {
        Ok(s) => s,
        Err(_) => return Ok(()),
    };
    if let Some(n) = chunk_count(&raw) {
        for i in 0..n {
            match Entry::new(SERVICE, &chunk_account(account, i))?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(())
}

pub fn delete_secret(account: &str) -> anyhow::Result<()> {
    delete_chunks(account)?;
    let entry = Entry::new(SERVICE, account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ----- Quy ước tên account -----
pub fn host_password(host_id: &str) -> String {
    format!("hostpass:{host_id}")
}
pub fn key_secret(key_id: &str) -> String {
    format!("sshkey:{key_id}")
}
pub fn key_passphrase(key_id: &str) -> String {
    format!("sshkey-pass:{key_id}")
}
pub fn proxy_password(host_id: &str) -> String {
    format!("proxypass:{host_id}")
}
pub fn entry_password(entry_id: &str) -> String {
    format!("entrypass:{entry_id}")
}
pub fn entry_totp(entry_id: &str) -> String {
    format!("entrytotp:{entry_id}")
}
pub fn storage_secret(bucket_id: &str) -> String {
    format!("storagesecret:{bucket_id}")
}
pub fn db_password(conn_id: &str) -> String {
    format!("dbpass:{conn_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let acct = format!("test:{}", uuid::Uuid::new_v4());
        set_secret(&acct, "hunter2").expect("set");
        assert_eq!(get_secret(&acct).expect("get").as_deref(), Some("hunter2"));
        delete_secret(&acct).expect("delete");
        assert_eq!(get_secret(&acct).expect("get after del"), None);
    }

    /// Secret dài chia thành nhiều entry (như trên Windows) vẫn đọc lại nguyên vẹn,
    /// ghi đè bằng secret ngắn thì dọn hết entry phụ.
    #[test]
    fn long_secret_is_chunked() {
        let acct = format!("test:{}", uuid::Uuid::new_v4());
        let long: String = (0..250).map(|i| format!("ký tự {i}·")).collect();
        set_secret_split(&acct, &long, 100).expect("set long");
        assert!(Entry::new(SERVICE, &chunk_account(&acct, 1)).unwrap().get_password().is_ok());
        assert_eq!(get_secret(&acct).unwrap().as_deref(), Some(long.as_str()));
        set_secret_split(&acct, "short", 100).expect("overwrite");
        assert_eq!(get_secret(&acct).unwrap().as_deref(), Some("short"));
        assert!(matches!(Entry::new(SERVICE, &chunk_account(&acct, 0)).unwrap().get_password(), Err(Error::NoEntry)));
        set_secret_split(&acct, &long, 100).unwrap();
        delete_secret(&acct).unwrap();
        assert_eq!(get_secret(&acct).unwrap(), None);
        assert!(matches!(Entry::new(SERVICE, &chunk_account(&acct, 0)).unwrap().get_password(), Err(Error::NoEntry)));
    }
}
