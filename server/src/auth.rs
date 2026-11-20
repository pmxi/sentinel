use anyhow::{Result, ensure};
use axum::http::{HeaderMap, header};
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
    jti: Option<String>,
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
            jti: Some(uuid::Uuid::new_v4().to_string()),
            aud: None,
            purpose: None,
            provider: None,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )?)
}

#[derive(Clone)]
pub struct Session {
    pub key: String,
    pub expires: i64,
}

pub fn cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("sent_session="))
}

pub fn token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .or_else(|| cookie(headers))
}

pub fn session_info(token: &str, secret: &str) -> Option<Session> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_issuer(&["sent"]);
    validation.sub = Some("owner".into());
    validation.leeway = 0;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    (claims.role.as_deref() == Some("owner")).then(|| Session {
        key: claims
            .jti
            .unwrap_or_else(|| sent_core::normalize::content_hash(token)),
        expires: claims.exp,
    })
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
            jti: None,
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
    fn sessions_have_unique_nonces_expire_and_accept_legacy_cookies() {
        let token = session(SECRET).unwrap();
        let info = session_info(&token, SECRET).unwrap();
        assert_ne!(
            info.key,
            session_info(&session(SECRET).unwrap(), SECRET).unwrap().key
        );
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&["sent"]);
        let mut claims = decode::<Claims>(
            &token,
            &DecodingKey::from_secret(SECRET.as_bytes()),
            &validation,
        )
        .unwrap()
        .claims;
        claims.jti = None;
        let legacy = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert_eq!(
            session_info(&legacy, SECRET).unwrap().key,
            sent_core::normalize::content_hash(&legacy)
        );
        claims.exp = Utc::now().timestamp() - 1;
        let expired = encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(SECRET.as_bytes()),
        )
        .unwrap();
        assert!(session_info(&expired, SECRET).is_none());
    }
    #[test]
    fn session_and_oauth_are_separate() {
        assert!(session_info(&session(SECRET).unwrap(), SECRET).is_some());
        assert!(session_info("", SECRET).is_none());
        assert!(session_info(&session(SECRET).unwrap(), "wrong").is_none());
        let state = oauth("gmail", SECRET).unwrap();
        assert!(verify_oauth(&state, "gmail", SECRET).is_ok());
        assert!(verify_oauth(&state, "microsoft", SECRET).is_err());
        assert!(session_info(&state, SECRET).is_none());
        assert!(verify_oauth(&session(SECRET).unwrap(), "gmail", SECRET).is_err());
    }
}
