//! Sidecar: đọc file KeePass (.kdbx) và in danh sách entry ra stdout dạng JSON.
//!
//! Dùng:
//!   kdbx-import <path-to-.kdbx>
//! Mật khẩu master đọc từ stdin (một dòng). In JSON:
//!   { "ok": true, "entries": [ {title, username, password, url, notes, totp}, ... ] }
//! hoặc khi lỗi:
//!   { "ok": false, "error": "..." }
//! Luôn thoát code 0 (kết quả nằm trong JSON) để phía gọi đọc được thông báo lỗi.

use std::io::Read;

use serde::Serialize;

#[derive(Serialize)]
struct Entry {
    title: String,
    username: Option<String>,
    password: Option<String>,
    url: Option<String>,
    notes: Option<String>,
    totp: Option<String>,
    /// Đường dẫn nhóm KeePass (vd "EzTech/Vpn"); None nếu ở gốc.
    group: Option<String>,
}

/// Duyệt cây nhóm, giữ nguyên cấu trúc thư mục.
fn collect(group: &keepass::db::GroupRef, path: &str, out: &mut Vec<Entry>) {
    for en in group.entries() {
        out.push(Entry {
            title: en.get_title().unwrap_or("Untitled").to_string(),
            username: en.get_username().map(str::to_string).filter(|s| !s.is_empty()),
            password: en.get_password().map(str::to_string).filter(|s| !s.is_empty()),
            url: en.get_url().map(str::to_string).filter(|s| !s.is_empty()),
            notes: en.get("Notes").map(str::to_string).filter(|s| !s.is_empty()),
            totp: entry_totp(en.get_raw_otp_value(), en.get("TOTP Seed")),
            group: if path.is_empty() { None } else { Some(path.to_string()) },
        });
    }
    for sub in group.groups() {
        let name = sub.name.replace('/', "-");
        let child = if path.is_empty() { name } else { format!("{path}/{name}") };
        collect(&sub, &child, out);
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Ok { ok: bool, entries: Vec<Entry> },
    Err { ok: bool, error: String },
}

/// Lấy secret base32 từ giá trị otp (otpauth:// URL hoặc secret trần).
fn extract_totp_secret(otp: Option<&str>) -> Option<String> {
    let v = otp?.trim();
    if v.is_empty() {
        return None;
    }
    if let Some(idx) = v.find("secret=") {
        let s = v[idx + 7..].split(['&', '?']).next().unwrap_or("");
        if !s.is_empty() {
            return Some(normalize_seed(s));
        }
    }
    if !v.contains("://") {
        return Some(normalize_seed(v));
    }
    None
}

/// Chuẩn hóa base32 seed: bỏ khoảng trắng (KeePassXC hay format seed có dấu cách).
fn normalize_seed(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// TOTP của entry: ưu tiên field `otp` (otpauth URL, KeePassXC hiện đại),
/// fallback sang field cũ `TOTP Seed` (KeeOtp/thủ công) mà crate keepass không đọc.
/// Lưu ý: chỉ lấy được secret; period/digits/algorithm tùy chỉnh và Steam encoder
/// KHÔNG được giữ (app dùng SHA1/6 số/30s).
fn entry_totp(otp: Option<&str>, seed: Option<&str>) -> Option<String> {
    extract_totp_secret(otp).or_else(|| {
        let s = normalize_seed(seed?.trim());
        (!s.is_empty()).then_some(s)
    })
}

fn run() -> Result<Vec<Entry>, String> {
    let path = std::env::args().nth(1).ok_or("missing .kdbx path argument")?;
    let mut password = String::new();
    std::io::stdin()
        .read_to_string(&mut password)
        .map_err(|e| format!("read stdin: {e}"))?;
    let password = password.trim_end_matches(['\n', '\r']);

    let mut file = std::fs::File::open(&path).map_err(|e| format!("open file: {e}"))?;
    let key = keepass::DatabaseKey::new().with_password(password);
    let db = keepass::Database::open(&mut file, key)
        .map_err(|e| format!("cannot open database (wrong password?): {e}"))?;

    let mut out = Vec::new();
    collect(&db.root(), "", &mut out);
    Ok(out)
}

fn main() {
    let output = match run() {
        Ok(entries) => Output::Ok { ok: true, entries },
        Err(error) => Output::Err { ok: false, error },
    };
    println!("{}", serde_json::to_string(&output).unwrap());
}

#[cfg(test)]
mod tests {
    use super::extract_totp_secret;

    #[test]
    fn from_otpauth_url() {
        assert_eq!(
            extract_totp_secret(Some(
                "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
            )),
            Some("JBSWY3DPEHPK3PXP".to_string())
        );
    }

    #[test]
    fn from_bare_secret() {
        assert_eq!(
            extract_totp_secret(Some("JBSWY3DPEHPK3PXP")),
            Some("JBSWY3DPEHPK3PXP".to_string())
        );
    }

    #[test]
    fn empty_and_none() {
        assert_eq!(extract_totp_secret(None), None);
        assert_eq!(extract_totp_secret(Some("  ")), None);
        assert_eq!(extract_totp_secret(Some("otpauth://totp/x?issuer=y")), None);
    }

    #[test]
    fn strips_spaces_in_seed() {
        assert_eq!(
            extract_totp_secret(Some("JBSW Y3DP EHPK 3PXP")),
            Some("JBSWY3DPEHPK3PXP".to_string())
        );
    }

    #[test]
    fn falls_back_to_totp_seed_field() {
        use super::entry_totp;
        // Không có otp → dùng "TOTP Seed" (định dạng cũ KeePassXC/KeeOtp)
        assert_eq!(
            entry_totp(None, Some("JBSW Y3DP EHPK 3PXP")),
            Some("JBSWY3DPEHPK3PXP".to_string())
        );
        // Có otp thì ưu tiên otp
        assert_eq!(
            entry_totp(Some("otpauth://totp/x?secret=AAAA"), Some("BBBB")),
            Some("AAAA".to_string())
        );
        assert_eq!(entry_totp(None, None), None);
    }
}
