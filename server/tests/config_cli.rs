use std::process::Command;

#[test]
fn print_database_path_does_not_start_services_or_create_the_database() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing.sqlite");
    let result = Command::new(env!("CARGO_BIN_EXE_sent-server"))
        .arg("--print-database-path")
        .current_dir(directory.path())
        .env("SENT_DATABASE_PATH", &path)
        .env("PORT", "3000")
        .env_remove("SESSION_SECRET")
        .env_remove("SENT_PASSWORD_HASH")
        .output()
        .unwrap();
    assert!(result.status.success(), "{:?}", result.stderr);
    assert_eq!(
        String::from_utf8(result.stdout).unwrap().trim(),
        path.to_str().unwrap()
    );
    assert!(!path.exists());
}

#[test]
fn sqlite_backup_and_restore_scripts_use_the_app_configuration() {
    let result = Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/test-backup-restore.py"
        ))
        .env("SENT_SERVER_BIN", env!("CARGO_BIN_EXE_sent-server"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
