use crate::{
    config::Config,
    crypto::{decrypt_secret, encrypt_secret},
};
use anyhow::{Context, Result, bail, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone)]
pub struct Providers {
    config: Config,
    pool: PgPool,
    http: reqwest::Client,
}

pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl Providers {
    pub fn new(config: Config, pool: PgPool) -> Self {
        Self {
            config,
            pool,
            http: reqwest::Client::new(),
        }
    }

    fn key(&self) -> Result<&str> {
        Config::required(&self.config.token_encryption_key, "TOKEN_ENCRYPTION_KEY")
    }

    pub async fn exchange_code(&self, provider: &str, code: &str) -> Result<()> {
        ensure!(
            !self.config.fake_providers,
            "OAuth connections are disabled with fake providers"
        );
        let redirect = format!("{}/api/oauth/{provider}/callback", self.config.public_url);
        let (email, display_name, credentials) = if provider == "gmail" {
            let mut tokens = self
                .http
                .post("https://oauth2.googleapis.com/token")
                .form(&[
                    ("code", code),
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", &redirect),
                    (
                        "client_id",
                        Config::required(&self.config.google_client_id, "GOOGLE_CLIENT_ID")?,
                    ),
                    (
                        "client_secret",
                        Config::required(
                            &self.config.google_client_secret,
                            "GOOGLE_CLIENT_SECRET",
                        )?,
                    ),
                ])
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            tokens["expiry_date"] = json!(
                Utc::now().timestamp_millis()
                    + tokens["expires_in"].as_i64().unwrap_or(3600) * 1000
            );
            let access = tokens["access_token"]
                .as_str()
                .context("Google token response missing access token")?;
            let profile = self
                .http
                .get("https://www.googleapis.com/oauth2/v2/userinfo")
                .bearer_auth(access)
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            let email = profile["email"]
                .as_str()
                .context("Google profile did not include an email address")?
                .to_owned();
            (
                email.clone(),
                profile["name"].as_str().unwrap_or(&email).to_owned(),
                tokens,
            )
        } else if provider == "microsoft" {
            let client = Config::required(&self.config.microsoft_client_id, "MICROSOFT_CLIENT_ID")?;
            let tokens = self
                .http
                .post(format!(
                    "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                    self.config.microsoft_tenant_id
                ))
                .form(&[
                    ("code", code),
                    ("grant_type", "authorization_code"),
                    ("redirect_uri", &redirect),
                    ("client_id", client),
                    (
                        "client_secret",
                        Config::required(
                            &self.config.microsoft_client_secret,
                            "MICROSOFT_CLIENT_SECRET",
                        )?,
                    ),
                    ("client_info", "1"),
                ])
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            let identity = decode_jwt_payload(
                tokens["id_token"]
                    .as_str()
                    .context("Microsoft token response missing ID token")?,
            )?;
            let client_info: Value = serde_json::from_slice(
                &URL_SAFE_NO_PAD.decode(
                    tokens["client_info"]
                        .as_str()
                        .context("Microsoft response missing client_info")?,
                )?,
            )?;
            let uid = client_info["uid"]
                .as_str()
                .context("Microsoft response missing uid")?;
            let utid = client_info["utid"]
                .as_str()
                .context("Microsoft response missing utid")?;
            let home = format!("{uid}.{utid}");
            let realm = identity["tid"].as_str().unwrap_or(utid);
            let email = identity["preferred_username"]
                .as_str()
                .or_else(|| identity["email"].as_str())
                .context("Microsoft account missing username")?
                .to_lowercase();
            let name = identity["name"].as_str().unwrap_or(&email).to_owned();
            let environment = "login.windows.net";
            let target = tokens["scope"]
                .as_str()
                .unwrap_or("openid profile offline_access Mail.ReadWrite")
                .to_lowercase();
            let mut cache = json!({"Account":{},"IdToken":{},"AccessToken":{},"RefreshToken":{},"AppMetadata":{}});
            cache["Account"][format!("{home}-{environment}-{realm}").to_lowercase()] = json!({"home_account_id":home,"environment":environment,"realm":realm,"local_account_id":identity["oid"].as_str().unwrap_or(uid),"username":email,"authority_type":"MSSTS","name":name,"client_info":tokens["client_info"]});
            let base = json!({"home_account_id":home,"environment":environment,"client_id":client,"realm":realm});
            let mut id = base.clone();
            id["credential_type"] = json!("IdToken");
            id["secret"] = tokens["id_token"].clone();
            cache["IdToken"]
                [format!("{home}-{environment}-idtoken-{client}-{realm}-").to_lowercase()] = id;
            let mut access = base.clone();
            access["credential_type"] = json!("AccessToken");
            access["secret"] = tokens["access_token"].clone();
            access["target"] = json!(target);
            access["token_type"] = json!("Bearer");
            access["cached_at"] = json!(Utc::now().timestamp().to_string());
            access["expires_on"] = json!(
                (Utc::now().timestamp() + tokens["expires_in"].as_i64().unwrap_or(3600))
                    .to_string()
            );
            access["extended_expires_on"] = access["expires_on"].clone();
            cache["AccessToken"][format!(
                "{home}-{environment}-accesstoken-{client}-{realm}-{target}--"
            )
            .to_lowercase()] = access;
            let mut refresh = base;
            refresh["credential_type"] = json!("RefreshToken");
            refresh["secret"] = tokens["refresh_token"].clone();
            cache["RefreshToken"]
                [format!("{home}-{environment}-refreshtoken-{client}--").to_lowercase()] = refresh;
            (
                email,
                name,
                json!({"homeAccountId":home,"cache":serde_json::to_string(&cache)?}),
            )
        } else {
            bail!("Invalid provider");
        };
        let encrypted = encrypt_secret(&serde_json::to_string(&credentials)?, self.key()?)?;
        let row=sqlx::query("insert into accounts(provider,email,display_name,encrypted_credentials,status,updated_at) values($1::text::provider,$2,$3,$4,'active',now()) on conflict(provider,email) do update set display_name=excluded.display_name,encrypted_credentials=excluded.encrypted_credentials,status='active',last_error=null,updated_at=now() returning id")
            .bind(provider).bind(email.to_lowercase()).bind(display_name).bind(encrypted).fetch_one(&self.pool).await?;
        sqlx::query("insert into sync_cursors(account_id) values($1) on conflict do nothing")
            .bind(row.get::<Uuid, _>("id"))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn access_token(
        &self,
        account_id: Uuid,
        provider: &str,
        encrypted: &str,
    ) -> Result<String> {
        ensure!(
            !self.config.fake_providers,
            "Fake provider must not request real credentials"
        );
        ensure!(
            !encrypted.starts_with("sent-fake-provider:"),
            "Fake accounts cannot contact real providers"
        );
        let mut credentials: Value =
            serde_json::from_str(&decrypt_secret(encrypted, self.key()?)?)?;
        let token = if provider == "gmail" {
            if credentials["expiry_date"].as_i64().unwrap_or(0)
                > Utc::now().timestamp_millis() + 60_000
            {
                return Ok(credentials["access_token"]
                    .as_str()
                    .context("Missing Gmail access token")?
                    .into());
            }
            let tokens = self
                .http
                .post("https://oauth2.googleapis.com/token")
                .form(&[
                    ("grant_type", "refresh_token"),
                    (
                        "refresh_token",
                        credentials["refresh_token"]
                            .as_str()
                            .context("Missing Gmail refresh token")?,
                    ),
                    (
                        "client_id",
                        Config::required(&self.config.google_client_id, "GOOGLE_CLIENT_ID")?,
                    ),
                    (
                        "client_secret",
                        Config::required(
                            &self.config.google_client_secret,
                            "GOOGLE_CLIENT_SECRET",
                        )?,
                    ),
                ])
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            let access = tokens["access_token"]
                .as_str()
                .context("Missing Gmail access token")?
                .to_owned();
            let expiry = Utc::now().timestamp_millis()
                + tokens["expires_in"].as_i64().unwrap_or(3600) * 1000;
            for (key, value) in tokens.as_object().context("Invalid token response")? {
                credentials[key] = value.clone();
            }
            credentials["expiry_date"] = json!(expiry);
            access
        } else {
            let mut cache: Value = serde_json::from_str(
                credentials["cache"]
                    .as_str()
                    .context("Missing MSAL cache")?,
            )?;
            let home = credentials["homeAccountId"]
                .as_str()
                .context("Missing MSAL account")?;
            if let Some(access) = cache["AccessToken"].as_object().and_then(|o| {
                o.values().find(|a| {
                    a["home_account_id"] == home
                        && a["expires_on"]
                            .as_str()
                            .and_then(|s| s.parse::<i64>().ok())
                            .unwrap_or(0)
                            > Utc::now().timestamp() + 60
                })
            }) {
                return Ok(access["secret"]
                    .as_str()
                    .context("Missing MSAL access token")?
                    .into());
            }
            let refresh = cache["RefreshToken"]
                .as_object()
                .and_then(|o| o.values().find(|r| r["home_account_id"] == home))
                .context("Missing MSAL refresh token")?;
            let tokens = self
                .http
                .post(format!(
                    "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
                    self.config.microsoft_tenant_id
                ))
                .form(&[
                    ("grant_type", "refresh_token"),
                    (
                        "refresh_token",
                        refresh["secret"]
                            .as_str()
                            .context("Missing refresh token secret")?,
                    ),
                    (
                        "client_id",
                        Config::required(&self.config.microsoft_client_id, "MICROSOFT_CLIENT_ID")?,
                    ),
                    (
                        "client_secret",
                        Config::required(
                            &self.config.microsoft_client_secret,
                            "MICROSOFT_CLIENT_SECRET",
                        )?,
                    ),
                ])
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await?;
            let access = tokens["access_token"]
                .as_str()
                .context("Missing Graph access token")?
                .to_owned();
            if let Some(entries) = cache["AccessToken"].as_object_mut() {
                for entry in entries
                    .values_mut()
                    .filter(|v| v["home_account_id"] == home)
                {
                    entry["secret"] = json!(access);
                    entry["expires_on"] = json!(
                        (Utc::now().timestamp() + tokens["expires_in"].as_i64().unwrap_or(3600))
                            .to_string()
                    );
                }
            }
            if let Some(token) = tokens["refresh_token"].as_str()
                && let Some(entries) = cache["RefreshToken"].as_object_mut()
            {
                for entry in entries
                    .values_mut()
                    .filter(|v| v["home_account_id"] == home)
                {
                    entry["secret"] = json!(token);
                }
            }
            credentials["cache"] = json!(serde_json::to_string(&cache)?);
            access
        };
        sqlx::query("update accounts set encrypted_credentials=$2,updated_at=now() where id=$1")
            .bind(account_id)
            .bind(encrypt_secret(
                &serde_json::to_string(&credentials)?,
                self.key()?,
            )?)
            .execute(&self.pool)
            .await?;
        Ok(token)
    }

    pub async fn fetch_attachment(
        &self,
        message_id: Uuid,
        attachment_id: &str,
    ) -> Result<Attachment> {
        let row=sqlx::query("select m.attachments,m.provider_message_id,a.id account_id,a.provider::text,a.encrypted_credentials from messages m join accounts a on a.id=m.account_id where m.id=$1").bind(message_id).fetch_optional(&self.pool).await?.context("Message not found")?;
        let metadata: Value = row.get("attachments");
        let item = metadata
            .as_array()
            .and_then(|a| a.iter().find(|a| a["id"] == attachment_id))
            .context("Attachment not found")?;
        if self.config.fake_providers {
            let mut bytes = format!("Deterministic fake attachment {attachment_id}\n").into_bytes();
            bytes.resize(item["size"].as_u64().unwrap_or(48) as usize, b' ');
            return Ok(Attachment {
                filename: item["filename"].as_str().unwrap_or("attachment.txt").into(),
                content_type: item["contentType"]
                    .as_str()
                    .unwrap_or("application/octet-stream")
                    .into(),
                bytes,
            });
        }
        let provider: String = row.get("provider");
        let token = self
            .access_token(
                row.get("account_id"),
                &provider,
                &row.get::<String, _>("encrypted_credentials"),
            )
            .await?;
        let provider_message: String = row.get("provider_message_id");
        let mut url = reqwest::Url::parse(if provider == "gmail" {
            "https://gmail.googleapis.com/"
        } else {
            "https://graph.microsoft.com/"
        })?;
        if provider == "gmail" {
            url.path_segments_mut().expect("base URL").extend([
                "gmail",
                "v1",
                "users",
                "me",
                "messages",
                &provider_message,
                "attachments",
                attachment_id,
            ]);
        } else {
            url.path_segments_mut().expect("base URL").extend([
                "v1.0",
                "me",
                "messages",
                &provider_message,
                "attachments",
                attachment_id,
            ]);
        }
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .header("Prefer", "IdType=\"ImmutableId\"")
            .send()
            .await?
            .error_for_status()?
            .json::<Value>()
            .await?;
        let bytes = if provider == "gmail" {
            URL_SAFE_NO_PAD.decode(
                response["data"]
                    .as_str()
                    .context("Missing attachment data")?,
            )?
        } else {
            STANDARD.decode(
                response["contentBytes"]
                    .as_str()
                    .context("Missing attachment content")?,
            )?
        };
        Ok(Attachment {
            filename: item["filename"].as_str().unwrap_or("attachment").into(),
            content_type: item["contentType"]
                .as_str()
                .unwrap_or("application/octet-stream")
                .into(),
            bytes,
        })
    }
}

fn decode_jwt_payload(token: &str) -> Result<Value> {
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(
        token.split('.').nth(1).context("Invalid ID token")?,
    )?)?)
}
