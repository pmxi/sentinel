use anyhow::{Result, ensure};
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct Claims {
    iss: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    iat: i64,
    exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aud: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

pub fn session(secret: &str) -> Result<String> {
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &Claims {
            iss: "sent".into(),
            sub: Some("owner".into()),
            role: Some("owner".into()),
            iat: Utc::now().timestamp(),
            exp: Utc::now().timestamp() + 30 * 86400,
            aud: None,
            purpose: None,
            provider: None,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )?)
}

pub fn verify_session(token: &str, secret: &str) -> bool {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["sent"]);
    validation.sub = Some("owner".into());
    validation.leeway = 0;
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .is_ok_and(|t| t.claims.role.as_deref() == Some("owner"))
}

pub fn oauth(provider: &str, secret: &str) -> Result<String> {
    Ok(encode(
        &Header::new(Algorithm::HS256),
        &Claims {
            iss: "sent".into(),
            sub: None,
            role: None,
            iat: Utc::now().timestamp(),
            exp: Utc::now().timestamp() + 600,
            aud: Some("oauth".into()),
            purpose: Some("oauth-connect".into()),
            provider: Some(provider.into()),
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )?)
}

pub fn verify_oauth(token: &str, provider: &str, secret: &str) -> Result<()> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["sent"]);
    validation.set_audience(&["oauth"]);
    validation.leeway = 0;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?
    .claims;
    ensure!(
        claims.purpose.as_deref() == Some("oauth-connect")
            && claims.provider.as_deref() == Some(provider),
        "Invalid OAuth state"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const SECRET: &str = "test-session-secret-at-least-32-chars";
    #[test]
    fn session_and_oauth_are_separate() {
        assert!(verify_session(&session(SECRET).unwrap(), SECRET));
        assert!(!verify_session("", SECRET));
        assert!(!verify_session(&session(SECRET).unwrap(), "wrong"));
        let state = oauth("gmail", SECRET).unwrap();
        assert!(verify_oauth(&state, "gmail", SECRET).is_ok());
        assert!(verify_oauth(&state, "microsoft", SECRET).is_err());
        assert!(!verify_session(&state, SECRET));
        assert!(verify_oauth(&session(SECRET).unwrap(), "gmail", SECRET).is_err());
    }
}
