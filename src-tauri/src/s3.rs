//! S3-compatible client (AWS S3, Cloudflare R2, MinIO) ký AWS Signature V4 thủ công.
//! Dùng path-style (tương thích R2/MinIO/S3), reqwest cho HTTP, hmac/sha2 cho ký.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNSIGNED: &str = "UNSIGNED-PAYLOAD";

#[derive(Serialize)]
pub struct S3Object {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
}

#[derive(Serialize)]
pub struct Listing {
    pub prefixes: Vec<String>,
    pub objects: Vec<S3Object>,
    pub next_token: Option<String>,
}

pub struct S3 {
    endpoint: String, // scheme://host[:port], không có "/" cuối
    region: String,
    access_key: String,
    secret_key: String,
    bucket: String,
    http: reqwest::Client,
}

// ---------- helpers ký ----------

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac key");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex_lower(&h.finalize())
}

fn hex_lower(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// Mã hóa URI theo chuẩn AWS (unreserved giữ nguyên; '/' tùy chọn).
fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// (amzdate YYYYMMDDTHHMMSSZ, datestamp YYYYMMDD) theo UTC.
fn amz_dates() -> (String, String) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    (
        format!("{y:04}{m:02}{d:02}T{h:02}{mi:02}{s:02}Z"),
        format!("{y:04}{m:02}{d:02}"),
    )
}

/// Đổi số ngày kể từ 1970-01-01 sang (năm, tháng, ngày) — thuật toán Howard Hinnant.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

impl S3 {
    pub fn new(endpoint: String, region: String, access_key: String, secret_key: String, bucket: String) -> Self {
        let endpoint = endpoint.trim().trim_end_matches('/').to_string();
        let region = if region.trim().is_empty() { "auto".to_string() } else { region.trim().to_string() };
        Self { endpoint, region, access_key, secret_key, bucket, http: reqwest::Client::new() }
    }

    fn host(&self) -> String {
        self.endpoint.split("://").nth(1).unwrap_or(&self.endpoint).trim_end_matches('/').to_string()
    }

    fn signing_key(&self, datestamp: &str) -> Vec<u8> {
        let k = hmac(format!("AWS4{}", self.secret_key).as_bytes(), datestamp.as_bytes());
        let k = hmac(&k, self.region.as_bytes());
        let k = hmac(&k, b"s3");
        hmac(&k, b"aws4_request")
    }

    /// Dựng Authorization header từ canonical request + danh sách signed headers.
    fn auth_header(&self, canonical_request: &str, amzdate: &str, datestamp: &str, signed_headers: &str) -> String {
        let scope = format!("{datestamp}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amzdate}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let sig = hex_lower(&hmac(&self.signing_key(datestamp), string_to_sign.as_bytes()));
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={sig}",
            self.access_key
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn authorization(
        &self,
        method: &str,
        canonical_uri: &str,
        canonical_query: &str,
        host: &str,
        payload_hash: &str,
        amzdate: &str,
        datestamp: &str,
    ) -> String {
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_headers =
            format!("host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amzdate}\n");
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        self.auth_header(&canonical_request, amzdate, datestamp, signed_headers)
    }

    /// Liệt kê object (delimiter "/" tạo "thư mục"; rỗng = đệ quy toàn bộ).
    async fn list_page(&self, prefix: &str, delimiter: &str, token: Option<&str>) -> anyhow::Result<Listing> {
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}", uri_encode(&self.bucket, false));

        let mut params: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1000".into()),
            ("prefix".into(), prefix.to_string()),
        ];
        if !delimiter.is_empty() {
            params.push(("delimiter".into(), delimiter.to_string()));
        }
        if let Some(t) = token {
            params.push(("continuation-token".into(), t.to_string()));
        }
        params.sort();
        let canonical_query = params
            .iter()
            .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
            .collect::<Vec<_>>()
            .join("&");

        let auth = self.authorization("GET", &canonical_uri, &canonical_query, &host, EMPTY_SHA256, &amzdate, &datestamp);
        let url = format!("{}{}?{}", self.endpoint, canonical_uri, canonical_query);
        let resp = self
            .http
            .get(&url)
            .header("x-amz-date", &amzdate)
            .header("x-amz-content-sha256", EMPTY_SHA256)
            .header("Authorization", auth)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            anyhow::bail!("S3 list error {status}: {}", text.chars().take(300).collect::<String>());
        }
        Ok(parse_list_xml(&text))
    }

    /// Liệt kê một cấp (thư mục + file) trong `prefix`.
    pub async fn list(&self, prefix: &str, token: Option<&str>) -> anyhow::Result<Listing> {
        self.list_page(prefix, "/", token).await
    }

    /// Liệt kê đệ quy mọi key dưới `prefix` (dùng cho copy/move cả thư mục).
    pub async fn list_all_keys(&self, prefix: &str) -> anyhow::Result<Vec<String>> {
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let page = self.list_page(prefix, "", token.as_deref()).await?;
            keys.extend(page.objects.into_iter().map(|o| o.key));
            match page.next_token {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        Ok(keys)
    }

    /// Copy server-side một object (PUT + x-amz-copy-source, không tải dữ liệu qua client).
    pub async fn copy(&self, src_key: &str, dst_key: &str) -> anyhow::Result<()> {
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(dst_key, false));
        let copy_source = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(src_key, false));
        let signed_headers = "host;x-amz-content-sha256;x-amz-copy-source;x-amz-date";
        let canonical_headers = format!(
            "host:{host}\nx-amz-content-sha256:{EMPTY_SHA256}\nx-amz-copy-source:{copy_source}\nx-amz-date:{amzdate}\n"
        );
        let canonical_request =
            format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{EMPTY_SHA256}");
        let auth = self.auth_header(&canonical_request, &amzdate, &datestamp, signed_headers);
        let url = format!("{}{}", self.endpoint, canonical_uri);
        let resp = self
            .http
            .put(&url)
            .header("x-amz-date", &amzdate)
            .header("x-amz-content-sha256", EMPTY_SHA256)
            .header("x-amz-copy-source", &copy_source)
            .header("Authorization", auth)
            .header("Content-Length", 0)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("S3 copy error {status}: {}", t.chars().take(300).collect::<String>());
        }
        Ok(())
    }

    pub async fn delete(&self, key: &str) -> anyhow::Result<()> {
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(key, false));
        let auth = self.authorization("DELETE", &canonical_uri, "", &host, EMPTY_SHA256, &amzdate, &datestamp);
        let url = format!("{}{}", self.endpoint, canonical_uri);
        let resp = self
            .http
            .delete(&url)
            .header("x-amz-date", &amzdate)
            .header("x-amz-content-sha256", EMPTY_SHA256)
            .header("Authorization", auth)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("S3 delete error {status}: {}", t.chars().take(300).collect::<String>());
        }
        Ok(())
    }

    /// PUT một body bất kỳ (UNSIGNED-PAYLOAD) lên `key`.
    async fn put_body(&self, key: &str, body: reqwest::Body, len: u64) -> anyhow::Result<()> {
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(key, false));
        let auth = self.authorization("PUT", &canonical_uri, "", &host, UNSIGNED, &amzdate, &datestamp);
        let url = format!("{}{}", self.endpoint, canonical_uri);
        let resp = self
            .http
            .put(&url)
            .header("x-amz-date", &amzdate)
            .header("x-amz-content-sha256", UNSIGNED)
            .header("Authorization", auth)
            .header("Content-Length", len)
            .header("Content-Type", guess_mime(key))
            .body(body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("S3 upload error {status}: {}", t.chars().take(300).collect::<String>());
        }
        Ok(())
    }

    /// Tạo "thư mục": PUT một object rỗng có key kết thúc bằng "/".
    pub async fn put_empty(&self, key: &str) -> anyhow::Result<()> {
        self.put_body(key, reqwest::Body::from(Vec::new()), 0).await
    }

    /// Upload file cục bộ lên `key` (stream).
    pub async fn put_file(&self, key: &str, path: &str) -> anyhow::Result<()> {
        let file = tokio::fs::File::open(path).await?;
        let len = file.metadata().await?.len();
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        self.put_body(key, body, len).await
    }

    /// Upload file, cộng dồn số byte đã gửi vào `counter` (cho progress bar).
    pub async fn put_counting(&self, key: &str, path: &str, counter: Arc<AtomicU64>) -> anyhow::Result<()> {
        use tokio::io::AsyncReadExt;
        let len = tokio::fs::metadata(path).await?.len();
        let path = path.to_string();
        let stream = async_stream::stream! {
            let mut file = match tokio::fs::File::open(&path).await {
                Ok(f) => f,
                Err(err) => { yield Err(err); return; }
            };
            let mut buf = vec![0u8; 65536];
            loop {
                match file.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        counter.fetch_add(n as u64, Ordering::Relaxed);
                        yield Ok(bytes::Bytes::copy_from_slice(&buf[..n]));
                    }
                    Err(err) => { yield Err(err); break; }
                }
            }
        };
        let body = reqwest::Body::wrap_stream(stream);
        self.put_body(key, body, len).await
    }

    /// Tải object về file cục bộ (stream, không nạp hết vào RAM).
    pub async fn get_to_file(&self, key: &str, dest: &str) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(key, false));
        let auth = self.authorization("GET", &canonical_uri, "", &host, EMPTY_SHA256, &amzdate, &datestamp);
        let url = format!("{}{}", self.endpoint, canonical_uri);
        let mut resp = self
            .http
            .get(&url)
            .header("x-amz-date", &amzdate)
            .header("x-amz-content-sha256", EMPTY_SHA256)
            .header("Authorization", auth)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            anyhow::bail!("S3 download error {status}: {}", t.chars().take(300).collect::<String>());
        }
        let mut file = tokio::fs::File::create(dest).await?;
        while let Some(chunk) = resp.chunk().await? {
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok(())
    }

    /// Sinh URL tải xuống có chữ ký (presigned GET), hết hạn sau `expires` giây.
    pub fn presign_get(&self, key: &str, expires: u64) -> String {
        let host = self.host();
        let (amzdate, datestamp) = amz_dates();
        let canonical_uri = format!("/{}/{}", uri_encode(&self.bucket, false), uri_encode(key, false));
        let scope = format!("{datestamp}/{}/s3/aws4_request", self.region);
        let credential = format!("{}/{}", self.access_key, scope);

        let mut params: Vec<(String, String)> = vec![
            ("X-Amz-Algorithm".into(), "AWS4-HMAC-SHA256".into()),
            ("X-Amz-Credential".into(), credential),
            ("X-Amz-Date".into(), amzdate.clone()),
            ("X-Amz-Expires".into(), expires.to_string()),
            ("X-Amz-SignedHeaders".into(), "host".into()),
        ];
        params.sort();
        let canonical_query = params
            .iter()
            .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
            .collect::<Vec<_>>()
            .join("&");

        let canonical_request =
            format!("GET\n{canonical_uri}\n{canonical_query}\nhost:{host}\n\nhost\n{UNSIGNED}");
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amzdate}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let sig = hex_lower(&hmac(&self.signing_key(&datestamp), string_to_sign.as_bytes()));
        format!("{}{}?{}&X-Amz-Signature={}", self.endpoint, canonical_uri, canonical_query, sig)
    }
}

// ---------- parse XML ListObjectsV2 ----------

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// Lấy nội dung <tag>..</tag> đầu tiên trong `xml` (đã unescape).
fn first_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    if let Some(i) = xml.find(&open) {
        let start = i + open.len();
        if let Some(j) = xml[start..].find(&close) {
            return unescape(&xml[start..start + j]);
        }
    }
    String::new()
}

/// Tách các khối <tag>..</tag>.
fn blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let start = i + open.len();
        if let Some(j) = rest[start..].find(&close) {
            out.push(&rest[start..start + j]);
            rest = &rest[start + j + close.len()..];
        } else {
            break;
        }
    }
    out
}

fn parse_list_xml(xml: &str) -> Listing {
    let objects = blocks(xml, "Contents")
        .into_iter()
        .filter_map(|b| {
            let key = first_tag(b, "Key");
            if key.is_empty() {
                return None;
            }
            Some(S3Object {
                size: first_tag(b, "Size").parse().unwrap_or(0),
                last_modified: first_tag(b, "LastModified"),
                key,
            })
        })
        .collect();
    let prefixes = blocks(xml, "CommonPrefixes")
        .into_iter()
        .map(|b| first_tag(b, "Prefix"))
        .filter(|p| !p.is_empty())
        .collect();
    let nt = first_tag(xml, "NextContinuationToken");
    Listing {
        objects,
        prefixes,
        next_token: if nt.is_empty() { None } else { Some(nt) },
    }
}

fn guess_mime(key: &str) -> &'static str {
    let ext = key.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "log" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "text/javascript",
        "csv" => "text/csv",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hinnant_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(18993), (2022, 1, 1));
    }

    #[test]
    fn encode() {
        assert_eq!(uri_encode("a b/c", false), "a%20b/c");
        assert_eq!(uri_encode("a b/c", true), "a%20b%2Fc");
    }

    #[test]
    fn parse_xml() {
        let xml = r#"<ListBucketResult><Contents><Key>a/b.txt</Key><Size>12</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents><CommonPrefixes><Prefix>photos/</Prefix></CommonPrefixes></ListBucketResult>"#;
        let l = parse_list_xml(xml);
        assert_eq!(l.objects.len(), 1);
        assert_eq!(l.objects[0].key, "a/b.txt");
        assert_eq!(l.objects[0].size, 12);
        assert_eq!(l.prefixes, vec!["photos/"]);
    }
}
