//! Lưu secret (mật khẩu host, private key, passphrase) vào OS keychain
//! qua secret-service. Không bao giờ ghi plaintext vào SQLite.

use keyring::{Entry, Error};

// Namespace keychain giữ nguyên (không đổi theo tên app) để không mất secret đã lưu
// khi app đổi tên/identifier. Đây là chuỗi nội bộ, không hiển thị cho người dùng.
const SERVICE: &str = "com.terminus.app";

pub fn set_secret(account: &str, secret: &str) -> anyhow::Result<()> {
    let entry = Entry::new(SERVICE, account)?;
    entry.set_password(secret)?;
    Ok(())
}

pub fn get_secret(account: &str) -> anyhow::Result<Option<String>> {
    let entry = Entry::new(SERVICE, account)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_secret(account: &str) -> anyhow::Result<()> {
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
}
