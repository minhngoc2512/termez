//! Quản lý DNS Cloudflare qua REST API (client/v4). Xác thực bằng API Token (Bearer).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE: &str = "https://api.cloudflare.com/client/v4";

#[derive(Deserialize)]
struct Envelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<CfError>,
    result: Option<T>,
}

#[derive(Deserialize)]
struct CfError {
    code: i64,
    message: String,
}

#[derive(Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Serialize, Deserialize)]
pub struct DnsRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub rec_type: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub ttl: i64,
    #[serde(default)]
    pub proxied: bool,
    #[serde(default)]
    pub proxiable: bool,
    #[serde(default)]
    pub priority: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// Dữ liệu tạo/sửa bản ghi (gửi lên Cloudflare).
#[derive(Serialize, Deserialize, Clone)]
pub struct DnsInput {
    #[serde(rename = "type")]
    pub rec_type: String,
    pub name: String,
    pub content: String,
    #[serde(default = "default_ttl")]
    pub ttl: i64,
    #[serde(default)]
    pub proxied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

fn default_ttl() -> i64 {
    1
}

pub struct CfClient {
    base: String,
    http: reqwest::Client,
    token: String,
}

impl CfClient {
    pub fn new(base: String, token: String) -> Self {
        let base = base.trim().trim_end_matches('/').to_string();
        let base = if base.is_empty() { DEFAULT_BASE.to_string() } else { base };
        Self { base, http: reqwest::Client::new(), token }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn send<T: DeserializeOwned>(&self, req: reqwest::RequestBuilder) -> anyhow::Result<T> {
        let resp = req.bearer_auth(&self.token).send().await?;
        let env: Envelope<T> = resp.json().await?;
        if !env.success {
            let msg = env
                .errors
                .into_iter()
                .map(|e| format!("{} ({})", e.message, e.code))
                .collect::<Vec<_>>()
                .join("; ");
            anyhow::bail!(if msg.is_empty() {
                "Cloudflare API error".to_string()
            } else {
                msg
            });
        }
        env.result
            .ok_or_else(|| anyhow::anyhow!("Cloudflare: empty result"))
    }

    /// Kiểm tra token hợp lệ (GET /user/tokens/verify).
    pub async fn verify(&self) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        struct V {
            #[allow(dead_code)]
            status: String,
        }
        let _: V = self.send(self.http.get(self.url("/user/tokens/verify"))).await?;
        Ok(())
    }

    pub async fn list_zones(&self, account_id: Option<&str>) -> anyhow::Result<Vec<Zone>> {
        let mut req = self.http.get(self.url("/zones")).query(&[("per_page", "50")]);
        if let Some(a) = account_id.filter(|s| !s.is_empty()) {
            req = req.query(&[("account.id", a)]);
        }
        self.send(req).await
    }

    pub async fn list_records(&self, zone: &str) -> anyhow::Result<Vec<DnsRecord>> {
        let req = self
            .http
            .get(self.url(&format!("/zones/{zone}/dns_records")))
            .query(&[("per_page", "500")]);
        self.send(req).await
    }

    pub async fn create_record(&self, zone: &str, input: &DnsInput) -> anyhow::Result<DnsRecord> {
        let req = self
            .http
            .post(self.url(&format!("/zones/{zone}/dns_records")))
            .json(input);
        self.send(req).await
    }

    pub async fn update_record(
        &self,
        zone: &str,
        id: &str,
        input: &DnsInput,
    ) -> anyhow::Result<DnsRecord> {
        let req = self
            .http
            .put(self.url(&format!("/zones/{zone}/dns_records/{id}")))
            .json(input);
        self.send(req).await
    }

    pub async fn delete_record(&self, zone: &str, id: &str) -> anyhow::Result<()> {
        #[derive(Deserialize)]
        struct Del {
            #[allow(dead_code)]
            id: String,
        }
        let req = self
            .http
            .delete(self.url(&format!("/zones/{zone}/dns_records/{id}")));
        let _: Del = self.send(req).await?;
        Ok(())
    }
}
