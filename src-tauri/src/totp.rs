//! Sinh mã TOTP (2FA) từ secret base32.

use totp_rs::{Algorithm, Builder, Secret, Totp};

fn build(secret_b32: &str) -> anyhow::Result<Totp> {
    let cleaned = secret_b32.trim().replace([' ', '-'], "").to_uppercase();
    let secret = Secret::try_from_base32(&cleaned)
        .map_err(|e| anyhow::anyhow!("TOTP secret không hợp lệ: {e:?}"))?;
    Ok(Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_secret(secret)
        .with_skew(1)
        .with_step_duration(30)
        .with_issuer(Some("Termez"))
        .with_account_name("App Lock")
        .build_noncompliant())
}

/// Trả về (mã 6 số, số giây còn lại của chu kỳ 30s).
pub fn code(secret_b32: &str) -> anyhow::Result<(String, u64)> {
    let totp = build(secret_b32)?;
    let token = totp.generate_current().to_string();
    Ok((token, totp.ttl()))
}

/// Sinh secret base32 mới (dùng cho 2FA app lock).
pub fn generate_secret_b32() -> String {
    Secret::generate().to_base32()
}

/// otpauth:// URL để quét bằng app authenticator.
pub fn otpauth_url(secret_b32: &str) -> anyhow::Result<String> {
    Ok(build(secret_b32)?.to_url()?)
}

/// Xác thực mã 6 số theo secret (cho phép lệch 1 chu kỳ).
pub fn verify(secret_b32: &str, token: &str) -> bool {
    match build(secret_b32) {
        Ok(t) => t.check_current(token.trim()).is_some(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn totp_code_shape() {
        let (code, remaining) = super::code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert!(remaining >= 1 && remaining <= 30);
        assert!(super::code("not base32 !!!").is_err());
    }
}
