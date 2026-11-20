use anyhow::Result;
use chrono::{Duration, Utc};
use sent_core::{
    db,
    repository::{Repository, replica_fingerprint},
};
use serde_json::Value;
use uuid::Uuid;

#[tokio::test]
async fn committed_inventory_catches_concurrent_writes_archive_undo_and_tombstones() -> Result<()> {
    let Ok(url) = std::env::var("SENT_TEST_DATABASE_URL") else {
        eprintln!("Skipping: SENT_TEST_DATABASE_URL is unset");
        return Ok(());
    };
    anyhow::ensure!(
        reqwest::Url::parse(&url)?.path().starts_with("/sent_test_"),
        "Use an isolated sent_test_* database"
    );
    let pool = db::pool(&url, true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool.clone());
    let account = Uuid::new_v4();
    let thread = Uuid::new_v4();
    let id = Uuid::new_v4();
    sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values($1,'microsoft',$2,'test')").bind(account).bind(format!("{account}@test")).execute(&pool).await?;
    sqlx::query("insert into threads(id,account_id,provider_thread_id,last_message_at) values($1,$2,$1::text,now())")
        .bind(thread)
        .bind(account)
        .execute(&pool)
        .await?;
    sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,received_at,text_body,direction) values($1,$2,$3,$1::text,now(),'Body','inbound')").bind(id).bind(account).bind(thread).execute(&pool).await?;
    let ids = [id];
    let original = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(original["textBody"], "");
    assert_eq!(original["bodyAvailable"], false);
    let body = repo
        .replica_inventory(Some(&ids), true)
        .await?
        .messages
        .remove(0);
    assert_eq!(body["textBody"], "Body");
    assert_eq!(body["bodyVersion"], original["bodyVersion"]);
    let mut mutation = pool.begin().await?;
    sqlx::query("update messages set read=true,updated_at=now()-interval '1 day' where id=$1")
        .bind(id)
        .execute(&mut *mutation)
        .await?;
    let during = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(replica_fingerprint(&during), replica_fingerprint(&original));
    mutation.commit().await?;
    let after = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(after["read"], true);
    assert_ne!(replica_fingerprint(&after), replica_fingerprint(&original));
    let receipt = repo
        .enqueue_action(id, "archive", Some(Utc::now() + Duration::seconds(30)))
        .await?;
    let archived = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(archived["archived"], true);
    assert_eq!(archived["syncPending"], true);
    repo.undo(receipt).await?;
    let undone = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(undone["archived"], false);
    assert_eq!(undone["syncPending"], false);
    repo.set_tier(id, Some(3)).await?;
    let tier = repo
        .replica_inventory(Some(&ids), false)
        .await?
        .messages
        .remove(0);
    assert_eq!(tier["tier"], 3);
    assert_eq!(tier["classified"], true);
    sqlx::query("update messages set text_body=repeat('x',262145) where id=$1")
        .bind(id)
        .execute(&pool)
        .await?;
    let capped = repo
        .replica_inventory(Some(&ids), true)
        .await?
        .messages
        .remove(0);
    assert_eq!(capped["bodyAvailable"], false);
    assert_eq!(capped["textBody"], "");
    assert_ne!(capped["bodyVersion"], body["bodyVersion"]);
    sqlx::query("update messages set tombstone=true where id=$1")
        .bind(id)
        .execute(&pool)
        .await?;
    assert!(
        repo.replica_inventory(Some(&ids), false)
            .await?
            .messages
            .is_empty()
    );
    sqlx::query("delete from accounts where id=$1")
        .bind(account)
        .execute(&pool)
        .await?;
    assert!(
        repo.replica_inventory(Some(&ids), false)
            .await?
            .messages
            .is_empty()
    );
    let _: Vec<Value> = repo.replica_inventory(None, false).await?.messages;
    Ok(())
}
