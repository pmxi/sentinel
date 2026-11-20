use anyhow::Result;
use sent_core::{
    db::{self, Uuid},
    repository::{Repository, SearchInput},
};
use serde_json::{Value, json};
use sqlx::Row;

fn search(q: &str) -> SearchInput {
    SearchInput {
        q: q.into(),
        account_id: None,
        tier: None,
        after: None,
        before: None,
        has_attachment: None,
        limit: None,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn new_databases_directories_and_sidecars_are_private() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir()?;
    let data = directory.path().join("private/nested");
    let path = data.join("sent.sqlite");
    let pool = db::pool(path.to_str().unwrap(), true).await?;
    sqlx::query("create table fixture(value text)")
        .execute(&pool)
        .await?;
    for dir in [directory.path().join("private"), data.clone()] {
        assert_eq!(std::fs::metadata(dir)?.permissions().mode() & 0o777, 0o700);
    }
    for suffix in ["", "-wal", "-shm"] {
        assert_eq!(
            std::fs::metadata(format!("{}{suffix}", path.display()))?
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    pool.close().await;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400))?;
    let _ = db::pool(path.to_str().unwrap(), true).await;
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o400
    );
    assert!(
        db::pool(
            directory
                .path()
                .join("missing-parent-file/child.sqlite")
                .to_str()
                .unwrap(),
            true
        )
        .await
        .is_ok()
    );
    Ok(())
}

#[tokio::test]
async fn migrations_handle_empty_directories_and_roll_back_errors() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pool = db::pool(directory.path().join("sent.sqlite").to_str().unwrap(), true).await?;
    let migrations = directory.path().join("migrations");
    std::fs::create_dir(&migrations)?;
    db::migrate(&pool, &migrations).await?;
    let file = migrations.join("0001.sql");
    std::fs::write(
        &file,
        "create table example(id text primary key); invalid sql;",
    )?;
    assert!(db::migrate(&pool, &migrations).await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from sent_migrations")
            .fetch_one(&pool)
            .await?,
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from sqlite_master where name='example'")
            .fetch_one(&pool)
            .await?,
        0
    );
    std::fs::write(&file, "create table example(id text primary key);")?;
    db::migrate(&pool, &migrations).await?;
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from sent_migrations")
            .fetch_one(&pool)
            .await?,
        1
    );
    assert!(
        db::migrate(&pool, &directory.path().join("missing"))
            .await
            .is_err()
    );
    Ok(())
}

#[tokio::test]
async fn sqlite_schema_search_and_vectors() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pool = db::pool(directory.path().join("sent.sqlite").to_str().unwrap(), true).await?;
    let migrations = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations");
    let (a, b) = tokio::join!(
        db::migrate(&pool, &migrations),
        db::migrate(&pool, &migrations)
    );
    a?;
    b?;
    assert_eq!(
        sqlx::query_scalar::<_, String>("pragma journal_mode")
            .fetch_one(&pool)
            .await?,
        "wal"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("pragma foreign_keys")
            .fetch_one(&pool)
            .await?,
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("pragma busy_timeout")
            .fetch_one(&pool)
            .await?,
        5000
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("pragma synchronous")
            .fetch_one(&pool)
            .await?,
        1
    );
    let repo = Repository(pool.clone());
    assert_eq!(
        repo.search(&search("missing"), None).await?["messages"],
        json!([])
    );
    assert!(repo.search(&search(""), None).await.is_err());
    let owner = repo
        .upsert_account("gmail", "sqlite@example.test", "Fixture", "fake")
        .await?;
    assert_eq!(
        sqlx::query_scalar::<_, String>("select typeof(id) from accounts")
            .fetch_one(&pool)
            .await?,
        "text"
    );
    let mut ids = Vec::new();
    for (subject, body) in [
        ("Running project", "alpha beta"),
        ("Other", "running project alpha gamma"),
        ("Unrelated", "nothing"),
    ] {
        let thread = Uuid::new_v4();
        let id = Uuid::new_v4();
        sqlx::query("insert into threads(id,account_id,provider_thread_id,last_message_at) values(?1,?2,?1,?3)").bind(thread).bind(owner).bind(db::timestamp(chrono::Utc::now())).execute(&pool).await?;
        sqlx::query("insert into messages(id,thread_id,account_id,provider_message_id,subject,text_body,from_addresses,received_at,direction) values(?1,?2,?3,?1,?4,?5,?6,?7,'inbound')")
            .bind(id).bind(thread).bind(owner).bind(subject).bind(body).bind(json!([{"address":"porter@example.test"}])).bind(db::timestamp(chrono::Utc::now())).execute(&pool).await?;
        ids.push(id);
    }
    let ranked = repo.search(&search("run project"), None).await?;
    assert_eq!(ranked["messages"].as_array().unwrap().len(), 2);
    assert_eq!(ranked["messages"][0]["id"], json!(ids[0]));
    assert_eq!(
        repo.search(&search("\"alpha beta\""), None).await?["messages"][0]["id"],
        json!(ids[0])
    );
    assert_eq!(
        repo.search(&search("alpha -gamma"), None).await?["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        repo.search(&search("beta OR nothing"), None).await?["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    for (query, count) in [
        ("-alpha", 1),
        ("alpha OR -gamma", 3),
        ("-alpha -nothing", 0),
        ("beta or nothing", 2),
    ] {
        assert_eq!(
            repo.search(&search(query), None).await?["messages"]
                .as_array()
                .unwrap()
                .len(),
            count
        );
    }
    for query in ["OR", "\"", "* : NEAR(foo) {bar}", "\" OR 1=1 --"] {
        repo.search(&search(query), None).await?;
    }
    let vector = vec![0.1; 3072];
    repo.save_embedding(ids[2], &vector, "fixture", "hash")
        .await?;
    let row = sqlx::query("select embedding,typeof(embedding) kind from embeddings")
        .fetch_one(&pool)
        .await?;
    assert_eq!(row.get::<String, _>("kind"), "blob");
    let bytes: Vec<u8> = row.get("embedding");
    assert_eq!(bytes.len(), 12288);
    assert_eq!(&bytes[..4], &0.1f32.to_le_bytes());
    assert!(
        repo.save_embedding(ids[0], &[], "fixture", "hash")
            .await
            .is_err()
    );
    assert!(
        repo.save_embedding(ids[0], &vec![f64::NAN; 3072], "fixture", "hash")
            .await
            .is_err()
    );
    let hybrid = repo.search(&search("run"), Some(vector)).await?;
    assert_eq!(hybrid["mode"], "hybrid");
    assert_eq!(hybrid["messages"].as_array().unwrap().len(), 3);
    assert!(
        hybrid["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == json!(ids[2]))
    );
    assert!(repo.search(&search("run"), Some(vec![])).await.is_err());
    sqlx::query("update messages set subject='changed',text_body='' where id=?1")
        .bind(ids[0])
        .execute(&pool)
        .await?;
    assert_eq!(
        repo.search(&search("run"), None).await?["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    sqlx::query("delete from accounts where id=?1")
        .bind(owner)
        .execute(&pool)
        .await?;
    assert_eq!(
        repo.search(&search("run"), None).await?["messages"],
        json!([])
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from messages_search")
            .fetch_one(&pool)
            .await?,
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("select count(*) from embeddings")
            .fetch_one(&pool)
            .await?,
        0
    );
    assert!(sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values(?1,'invalid','bad','bad')").bind(Uuid::new_v4()).execute(&pool).await.is_err());
    let _: Value = repo.list_accounts().await?;
    Ok(())
}
