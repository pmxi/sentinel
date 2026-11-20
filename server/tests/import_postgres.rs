use sha2::{Digest, Sha256};
use std::{
    path::Path,
    process::{Command, Output},
};

fn importer(args: &[&Path], url: Option<&str>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_sent-import-postgres"));
    command.args(args).env_remove("DATABASE_URL");
    if let Some(url) = url {
        command.env("DATABASE_URL", url);
    }
    command.output().unwrap()
}

#[test]
fn refuses_existing_targets_and_cleans_failed_imports() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("mail.sqlite");
    std::fs::write(&path, "untouched").unwrap();
    assert!(!importer(&[&path], None).status.success());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "untouched");
    std::fs::remove_file(&path).unwrap();
    let temp = directory.path().join("mail.sqlite.tmp");
    std::fs::write(&temp, "reserved").unwrap();
    assert!(!importer(&[&path], None).status.success());
    assert_eq!(std::fs::read_to_string(&temp).unwrap(), "reserved");
    std::fs::remove_file(&temp).unwrap();
    assert!(!importer(&[&path], None).status.success());
    assert!(!path.exists() && !temp.exists());
    assert!(
        !importer(&[Path::new("--check"), &path], None)
            .status
            .success()
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn check_empty_database_is_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("empty.sqlite");
    let pool = sent_core::db::pool(path.to_str().unwrap(), true)
        .await
        .unwrap();
    sent_core::db::migrate(
        &pool,
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await
    .unwrap();
    pool.close().await;
    let before = Sha256::digest(std::fs::read(&path).unwrap());
    let result = importer(&[Path::new("--check"), &path], None);
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let pool = sent_core::db::read_only_pool(&path).await.unwrap();
    assert!(
        sqlx::query("insert into worker_state(name) values ('not-allowed')")
            .execute(&pool)
            .await
            .is_err()
    );
    pool.close().await;
    assert_eq!(before, Sha256::digest(std::fs::read(&path).unwrap()));
}

#[test]
fn imports_postgres_fixture_when_available() {
    let Ok(url) = std::env::var("SENT_IMPORT_TEST_DATABASE_URL") else {
        eprintln!(
            "Skipping real Postgres import: set SENT_IMPORT_TEST_DATABASE_URL to an isolated migrated fixture database"
        );
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("imported.sqlite");
    let result = importer(&[&path], Some(&url));
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout).contains("integrity_check=ok foreign_key_check=ok")
    );
    let before = Sha256::digest(std::fs::read(&path).unwrap());
    let checked = importer(&[Path::new("--check"), &path], None);
    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert_eq!(before, Sha256::digest(std::fs::read(&path).unwrap()));
    assert!(!importer(&[&path], Some(&url)).status.success());
}
