//! Sinh & phân tích SSH key. Generate dùng `ssh-keygen` hệ thống (OpenSSH chuẩn);
//! import/parse dùng russh để validate và lấy public key + fingerprint.

use russh::keys::{decode_secret_key, HashAlg, PublicKey};
use std::fs;
use std::process::Command;

/// Thông tin dẫn xuất từ một private key.
pub struct KeyInfo {
    pub algorithm: String,
    pub public_key: String,
    pub fingerprint: String,
    pub private_pem: String,
}

fn fingerprint_and_alg(public_openssh: &str) -> anyhow::Result<(String, String)> {
    let pk = PublicKey::from_openssh(public_openssh)
        .map_err(|e| anyhow::anyhow!("public key không hợp lệ: {e}"))?;
    let fp = pk.fingerprint(HashAlg::Sha256).to_string();
    let alg = pk.algorithm().to_string();
    Ok((fp, alg))
}

/// Sinh key mới bằng ssh-keygen. `algorithm` ∈ {"ed25519","rsa"}.
pub fn generate(
    algorithm: &str,
    passphrase: Option<&str>,
    comment: &str,
) -> anyhow::Result<KeyInfo> {
    if algorithm != "ed25519" && algorithm != "rsa" {
        anyhow::bail!("thuật toán không hỗ trợ: {algorithm}");
    }
    let dir = std::env::temp_dir().join(format!("terminus-keygen-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir)?;
    let path = dir.join("key");

    let mut cmd = Command::new("ssh-keygen");
    cmd.arg("-t").arg(algorithm);
    if algorithm == "rsa" {
        cmd.arg("-b").arg("4096");
    }
    cmd.arg("-f")
        .arg(&path)
        .arg("-N")
        .arg(passphrase.unwrap_or(""))
        .arg("-C")
        .arg(comment)
        .arg("-q");

    let out = cmd.output();
    let result = (|| {
        let out = out?;
        if !out.status.success() {
            anyhow::bail!("ssh-keygen lỗi: {}", String::from_utf8_lossy(&out.stderr));
        }
        let private_pem = fs::read_to_string(&path)?;
        let public_key = fs::read_to_string(path.with_extension("pub"))?
            .trim()
            .to_string();
        let (fingerprint, alg) = fingerprint_and_alg(&public_key)?;
        Ok(KeyInfo {
            algorithm: alg,
            public_key,
            fingerprint,
            private_pem,
        })
    })();

    let _ = fs::remove_dir_all(&dir); // luôn dọn temp
    result
}

/// Validate + trích xuất thông tin từ private key có sẵn (import).
pub fn inspect(private_pem: &str, passphrase: Option<&str>) -> anyhow::Result<KeyInfo> {
    let key = decode_secret_key(private_pem, passphrase)
        .map_err(|e| anyhow::anyhow!("private key không hợp lệ hoặc sai passphrase: {e}"))?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|e| anyhow::anyhow!("không xuất được public key: {e}"))?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    let algorithm = key.algorithm().to_string();
    Ok(KeyInfo {
        algorithm,
        public_key,
        fingerprint,
        private_pem: private_pem.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_ed25519_then_inspect() {
        let gen = generate("ed25519", None, "test@terminus").expect("generate");
        assert!(gen.public_key.starts_with("ssh-ed25519"), "public: {}", gen.public_key);
        assert!(gen.fingerprint.starts_with("SHA256:"), "fp: {}", gen.fingerprint);
        assert!(gen.private_pem.contains("OPENSSH PRIVATE KEY"));

        // import lại chính private key vừa tạo → khớp fingerprint
        let ins = inspect(&gen.private_pem, None).expect("inspect");
        assert_eq!(ins.fingerprint, gen.fingerprint);
        assert_eq!(ins.public_key, gen.public_key);
    }

    #[test]
    fn generate_with_passphrase() {
        let gen = generate("ed25519", Some("pass123"), "enc").expect("generate enc");
        // sai passphrase phải fail
        assert!(inspect(&gen.private_pem, None).is_err());
        // đúng passphrase phải OK
        assert!(inspect(&gen.private_pem, Some("pass123")).is_ok());
    }
}
