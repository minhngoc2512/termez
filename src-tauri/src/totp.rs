//! Sinh mã TOTP (2FA) từ secret base32.

use totp_rs::{Algorithm, Builder, Secret};

/// Trả về (mã 6 số, số giây còn lại của chu kỳ 30s).
pub fn code(secret_b32: &str) -> anyhow::Result<(String, u64)> {
    let cleaned = secret_b32.trim().replace([' ', '-'], "").to_uppercase();
    let secret = Secret::try_from_base32(&cleaned)
        .map_err(|e| anyhow::anyhow!("TOTP secret không hợp lệ: {e:?}"))?;
    let totp = Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_secret(secret)
        .with_skew(1)
        .with_step_duration(30)
        .build_noncompliant();
    let token = totp.generate_current().to_string();
    Ok((token, totp.ttl()))
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
