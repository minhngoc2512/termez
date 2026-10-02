//! Access token OAuth2 của Google cho BigQuery.
//!
//! - Key JSON của service account: tự ký JWT (RS256, `ring`) rồi đổi lấy token.
//! - Application Default Credentials: file trong `GOOGLE_APPLICATION_CREDENTIALS`,
//!   hoặc file của `gcloud auth application-default login`, hoặc metadata server
//!   (máy chạy trên GCE/GKE).
//!
//! Token được cache tới khi gần hết hạn.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{RsaKeyPair, RSA_PKCS1_SHA256};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const SCOPE: &str = "https://www.googleapis.com/auth/bigquery";
const TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN: &str =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

#[derive(Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
    #[serde(default)]
    private_key_id: String,
    #[serde(default)]
    token_uri: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

#[derive(Deserialize)]
struct AuthorizedUser {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    #[serde(default)]
    quota_project_id: Option<String>,
    #[serde(default)]
    token_uri: Option<String>,
}

enum Source {
    ServiceAccount { email: String, key_id: String, signer: RsaKeyPair, token_uri: String },
    User { client_id: String, client_secret: String, refresh_token: String, token_uri: String },
    Metadata,
    /// Test: token cố định (server giả không kiểm tra).
    #[cfg(test)]
    Static(String),
}

pub struct GoogleAuth {
    source: Source,
    http: reqwest::Client,
    cached: Mutex<Option<(String, Instant)>>,
    /// Project lấy từ credential (project_id của key / quota project của gcloud).
    pub project_hint: Option<String>,
    /// Project tính quota cho credential người dùng (header x-goog-user-project).
    pub quota_project: Option<String>,
    /// Mô tả ngắn để hiện cho người dùng (email service account…).
    pub identity: String,
}

impl GoogleAuth {
    /// Từ nội dung một file credential JSON (service account hoặc authorized_user).
    pub fn from_json(text: &str, http: reqwest::Client) -> anyhow::Result<Self> {
        let v: Value = serde_json::from_str(text.trim())
            .map_err(|e| anyhow::anyhow!("The key isn't valid JSON ({e}). Paste the whole service account key file."))?;
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "service_account" => {
                let k: ServiceAccountKey = serde_json::from_value(v)?;
                let der = pem_to_der(&k.private_key)?;
                let signer = RsaKeyPair::from_pkcs8(&der)
                    .map_err(|e| anyhow::anyhow!("Can't read the private key in the service account file: {e}"))?;
                Ok(Self {
                    identity: k.client_email.clone(),
                    project_hint: k.project_id.clone(),
                    quota_project: None,
                    source: Source::ServiceAccount {
                        email: k.client_email,
                        key_id: k.private_key_id,
                        signer,
                        token_uri: k.token_uri.unwrap_or_else(|| TOKEN_URI.into()),
                    },
                    http,
                    cached: Mutex::new(None),
                })
            }
            "authorized_user" => {
                let u: AuthorizedUser = serde_json::from_value(v)?;
                Ok(Self {
                    identity: "gcloud user credentials".into(),
                    project_hint: u.quota_project_id.clone(),
                    quota_project: u.quota_project_id,
                    source: Source::User {
                        client_id: u.client_id,
                        client_secret: u.client_secret,
                        refresh_token: u.refresh_token,
                        token_uri: u.token_uri.unwrap_or_else(|| TOKEN_URI.into()),
                    },
                    http,
                    cached: Mutex::new(None),
                })
            }
            "" => anyhow::bail!("This JSON has no \"type\" — expected a service account key file."),
            other => anyhow::bail!(
                "Credential type \"{other}\" isn't supported yet — use a service account key, or run \
                 `gcloud auth application-default login`."
            ),
        }
    }

    /// Application Default Credentials theo thứ tự của thư viện Google.
    pub fn adc(http: reqwest::Client) -> anyhow::Result<Self> {
        if let Some(p) = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS").filter(|p| !p.is_empty()) {
            let text = std::fs::read_to_string(&p)
                .map_err(|e| anyhow::anyhow!("Can't read GOOGLE_APPLICATION_CREDENTIALS ({}): {e}", PathBuf::from(&p).display()))?;
            return Self::from_json(&text, http);
        }
        if let Some(p) = gcloud_adc_path().filter(|p| p.exists()) {
            return Self::from_json(&std::fs::read_to_string(&p)?, http);
        }
        Ok(Self {
            identity: "GCE metadata server".into(),
            project_hint: None,
            quota_project: None,
            source: Source::Metadata,
            http,
            cached: Mutex::new(None),
        })
    }

    #[cfg(test)]
    pub fn fixed(token: &str, http: reqwest::Client) -> Self {
        Self {
            identity: "test".into(),
            project_hint: None,
            quota_project: None,
            source: Source::Static(token.into()),
            http,
            cached: Mutex::new(None),
        }
    }

    /// Access token còn hạn (tự làm mới khi còn dưới 1 phút).
    pub async fn token(&self) -> anyhow::Result<String> {
        let mut cached = self.cached.lock().await;
        if let Some((t, until)) = cached.as_ref() {
            if *until > Instant::now() + Duration::from_secs(60) {
                return Ok(t.clone());
            }
        }
        let (token, ttl) = self.fetch().await?;
        *cached = Some((token.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(token)
    }

    async fn fetch(&self) -> anyhow::Result<(String, u64)> {
        let resp = match &self.source {
            Source::ServiceAccount { email, key_id, signer, token_uri } => {
                let assertion = sign_jwt(email, key_id, signer, token_uri)?;
                self.http
                    .post(token_uri)
                    .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", &assertion)])
                    .send()
                    .await?
            }
            Source::User { client_id, client_secret, refresh_token, token_uri } => {
                self.http
                    .post(token_uri)
                    .form(&[
                        ("grant_type", "refresh_token"),
                        ("client_id", client_id),
                        ("client_secret", client_secret),
                        ("refresh_token", refresh_token),
                    ])
                    .send()
                    .await?
            }
            Source::Metadata => self
                .http
                .get(format!("{METADATA_TOKEN}?scopes={SCOPE}"))
                .header("Metadata-Flavor", "Google")
                .timeout(Duration::from_secs(3))
                .send()
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "No Google credentials found. Run `gcloud auth application-default login`, set \
                         GOOGLE_APPLICATION_CREDENTIALS, or use a service account key."
                    )
                })?,
            #[cfg(test)]
            Source::Static(t) => return Ok((t.clone(), 3600)),
        };
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            let msg = body
                .get("error_description")
                .or_else(|| body.get("error"))
                .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                .unwrap_or_else(|| status.to_string());
            let hint = if matches!(self.source, Source::User { .. }) && (msg.contains("invalid_grant") || msg.contains("reauth")) {
                " — run `gcloud auth application-default login` again."
            } else {
                ""
            };
            anyhow::bail!("Google sign-in failed: {msg}{hint}");
        }
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Google sign-in returned no access token"))?;
        let ttl = body.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
        Ok((token.to_string(), ttl))
    }
}

/// File ADC mà `gcloud auth application-default login` ghi ra.
fn gcloud_adc_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLOUDSDK_CONFIG").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("application_default_credentials.json"));
    }
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("gcloud"));
    #[cfg(not(windows))]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("gcloud"));
    base.map(|b| b.join("application_default_credentials.json"))
}

/// PEM ("-----BEGIN PRIVATE KEY-----") → DER PKCS#8.
fn pem_to_der(pem: &str) -> anyhow::Result<Vec<u8>> {
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).map(str::trim).collect();
    STANDARD
        .decode(b64)
        .map_err(|e| anyhow::anyhow!("The private key in the service account file is malformed: {e}"))
}

fn sign_jwt(email: &str, key_id: &str, signer: &RsaKeyPair, aud: &str) -> anyhow::Result<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let header = json!({ "alg": "RS256", "typ": "JWT", "kid": key_id });
    let claims = json!({ "iss": email, "scope": SCOPE, "aud": aud, "iat": now, "exp": now + 3600 });
    let msg = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let mut sig = vec![0u8; signer.public().modulus_len()];
    signer
        .sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), msg.as_bytes(), &mut sig)
        .map_err(|_| anyhow::anyhow!("Signing the service account token failed"))?;
    Ok(format!("{msg}.{}", URL_SAFE_NO_PAD.encode(sig)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256};

    /// Key RSA chỉ dùng cho test (sinh riêng, không thuộc tài khoản nào).
    const TEST_KEY: &str = include_str!("testdata/test_sa_key.pem");

    #[test]
    fn signs_a_verifiable_jwt() {
        let key = json!({
            "type": "service_account",
            "client_email": "bot@demo.iam.gserviceaccount.com",
            "private_key": TEST_KEY,
            "private_key_id": "abc",
            "project_id": "demo-project",
        });
        let auth = GoogleAuth::from_json(&key.to_string(), reqwest::Client::new()).unwrap();
        assert_eq!(auth.project_hint.as_deref(), Some("demo-project"));
        let Source::ServiceAccount { signer, .. } = &auth.source else { panic!() };
        let jwt = sign_jwt("bot@demo.iam.gserviceaccount.com", "abc", signer, TOKEN_URI).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(claims["iss"], "bot@demo.iam.gserviceaccount.com");
        assert_eq!(claims["scope"], SCOPE);
        let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, signer.public().as_ref());
        public
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &URL_SAFE_NO_PAD.decode(parts[2]).unwrap())
            .expect("signature verifies");
    }

    #[test]
    fn rejects_unsupported_credentials() {
        let err = GoogleAuth::from_json(r#"{"type":"external_account"}"#, reqwest::Client::new()).err().unwrap();
        assert!(err.to_string().contains("isn't supported"));
        assert!(GoogleAuth::from_json("not json", reqwest::Client::new()).is_err());
    }
}
