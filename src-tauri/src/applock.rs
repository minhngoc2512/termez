//! Khóa ứng dụng: băm mật khẩu mở app bằng Argon2id, lưu chuỗi PHC vào keychain.
//! Đây là lớp chặn ở tầng UI (chống người lạ mở tool khi quên khóa máy), tách biệt
//! với master password đồng bộ cloud.

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::Argon2;

/// Băm mật khẩu → chuỗi PHC (tự sinh salt ngẫu nhiên, chứa sẵn tham số).
pub fn hash(password: &str) -> anyhow::Result<String> {
    Ok(Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|e| anyhow::anyhow!("hash: {e}"))?
        .to_string())
}

/// Kiểm tra mật khẩu so với chuỗi PHC đã lưu.
pub fn verify(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let phc = hash("open sesame").unwrap();
        assert!(verify("open sesame", &phc));
        assert!(!verify("wrong", &phc));
    }
}
