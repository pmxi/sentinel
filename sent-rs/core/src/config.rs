use anyhow::{Context, Result, bail};
use std::{env, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub host: String,
    pub port: u16,
    pub public_url: String,
    pub web_url: String,
    pub password_hash: Option<String>,
    pub session_secret: Option<String>,
    pub token_encryption_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub classification_model: String,
    pub embedding_model: String,
    pub google_client_id: Option<String>,
    pub google_client_secret: Option<String>,
    pub microsoft_client_id: Option<String>,
    pub microsoft_client_secret: Option<String>,
    pub microsoft_tenant_id: String,
    pub microsoft_mail_send_enabled: bool,
    pub fake_providers: bool,
    pub web_dist_path: PathBuf,
    pub migrations_path: PathBuf,
    pub log_level: String,
    pub node_env: String,
}

fn optional(name: &str) -> Option<String> {
    env::var(name).ok().filter(|s| !s.is_empty())
}

fn value(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.into())
}

fn boolean(name: &str) -> Result<bool> {
    match value(name, "false").as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => bail!("{name} must be true or false"),
    }
}

impl Config {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();
        let public_url = value("SENT_PUBLIC_URL", "http://localhost:3000");
        let port = value("PORT", "3000")
            .parse::<u16>()
            .context("Invalid PORT")?;
        if port == 0 {
            bail!("PORT must be between 1 and 65535");
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        Ok(Self {
            database_url: value("DATABASE_URL", "postgres://sent:sent@localhost:5432/sent"),
            host: value("HOST", "0.0.0.0"),
            port,
            web_url: optional("SENT_WEB_URL").unwrap_or_else(|| public_url.clone()),
            public_url,
            password_hash: optional("SENT_PASSWORD_HASH"),
            session_secret: optional("SESSION_SECRET"),
            token_encryption_key: optional("TOKEN_ENCRYPTION_KEY"),
            openai_api_key: optional("OPENAI_API_KEY"),
            classification_model: value("OPENAI_CLASSIFICATION_MODEL", "gpt-5.6-luna"),
            embedding_model: value("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large"),
            google_client_id: optional("GOOGLE_CLIENT_ID"),
            google_client_secret: optional("GOOGLE_CLIENT_SECRET"),
            microsoft_client_id: optional("MICROSOFT_CLIENT_ID"),
            microsoft_client_secret: optional("MICROSOFT_CLIENT_SECRET"),
            microsoft_tenant_id: value("MICROSOFT_TENANT_ID", "common"),
            microsoft_mail_send_enabled: boolean("MICROSOFT_MAIL_SEND_ENABLED")?,
            fake_providers: boolean("SENT_FAKE_PROVIDERS")?,
            web_dist_path: optional("WEB_DIST_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("apps/web/dist")),
            migrations_path: optional("MIGRATIONS_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join("packages/core/src/db/migrations")),
            log_level: value("LOG_LEVEL", "info"),
            node_env: value("NODE_ENV", "development"),
        })
    }

    pub fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str> {
        value
            .as_deref()
            .with_context(|| format!("Missing required configuration: {name}"))
    }
}
