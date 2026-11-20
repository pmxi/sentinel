use anyhow::{Result, ensure};
use argon2::password_hash::{PasswordHasher, SaltString, rand_core::OsRng};
use std::io::Read;

fn main() -> Result<()> {
    let password = match std::env::args().nth(1) {
        Some(password) => password,
        None => {
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            input.trim_end_matches(['\r', '\n']).to_owned()
        }
    };
    ensure!(
        password.chars().count() >= 10,
        "Use a password with at least 10 characters"
    );
    let salt = SaltString::generate(&mut OsRng);
    let hash = argon2::Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    println!("{hash}");
    Ok(())
}
