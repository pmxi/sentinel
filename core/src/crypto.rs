use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use anyhow::{Context, Result, anyhow, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rand::RngCore;

fn cipher(key: &str) -> Result<Aes256Gcm> {
    let key = STANDARD
        .decode(key)
        .context("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key")?;
    Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow!("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key"))
}

pub fn encrypt_secret(plaintext: &str, key: &str) -> Result<String> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    encrypt_with_iv(plaintext, key, iv)
}

fn encrypt_with_iv(plaintext: &str, key: &str, iv: [u8; 12]) -> Result<String> {
    let encrypted = cipher(key)?
        .encrypt(Nonce::from_slice(&iv), plaintext.as_bytes())
        .map_err(|_| anyhow!("Encryption failed"))?;
    let (ciphertext, tag) = encrypted.split_at(encrypted.len() - 16);
    Ok(format!(
        "v1.{}.{}.{}",
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

pub fn decrypt_secret(value: &str, key: &str) -> Result<String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" || parts[1..].iter().any(|s| s.is_empty()) {
        bail!("Encrypted secret has an unsupported format");
    }
    let iv = URL_SAFE_NO_PAD.decode(parts[1])?;
    let tag = URL_SAFE_NO_PAD.decode(parts[2])?;
    if iv.len() != 12 || tag.len() != 16 {
        bail!("Invalid encrypted secret nonce or tag");
    }
    let mut encrypted = URL_SAFE_NO_PAD.decode(parts[3])?;
    encrypted.extend_from_slice(&tag);
    let plaintext = cipher(key)?
        .decrypt(Nonce::from_slice(&iv), encrypted.as_ref())
        .map_err(|_| anyhow!("Decryption failed"))?;
    Ok(String::from_utf8(plaintext)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_compatible_vector() {
        let key = STANDARD.encode([0u8; 32]);
        let value = encrypt_with_iv("hello", &key, [0u8; 12]).unwrap();
        assert_eq!(value, "v1.AAAAAAAAAAAAAAAA.i5CPf2L_zqapL6vvOb9Nkw.psIsUSI");
        assert_eq!(decrypt_secret(&value, &key).unwrap(), "hello");
    }

    #[test]
    fn roundtrip_unicode_and_empty() {
        let key = STANDARD.encode([7u8; 32]);
        let value = encrypt_secret("邮件 🔑", &key).unwrap();
        assert_eq!(decrypt_secret(&value, &key).unwrap(), "邮件 🔑");
        assert!(encrypt_secret("", &key).is_ok());
        assert!(decrypt_secret("v1.a.b.", &key).is_err());
    }

    #[test]
    fn rejects_invalid_and_tampered_secrets() {
        let key = STANDARD.encode([7u8; 32]);
        assert!(encrypt_secret("secret", "bad").is_err());
        for value in ["", "v2.a.b.c", "v1.a.b.c", "v1.a.b.c.d"] {
            assert!(decrypt_secret(value, &key).is_err());
        }
        let value = encrypt_secret("secret", &key).unwrap();
        assert!(decrypt_secret(&value, &STANDARD.encode([8u8; 32])).is_err());
    }
}
