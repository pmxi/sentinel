use anyhow::Result;
use sent_core::db::Uuid;
use sent_core::{
    db,
    repository::{BodyVersionCache, Repository},
};
use serde_json::json;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn streamed_body_versions_match_the_buffered_digest_format() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("digest-compatibility.sqlite");
    let pool = db::pool(path.to_str().unwrap(), true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool.clone());
    let account = Uuid::new_v4();
    let thread = Uuid::new_v4();
    sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values(?1,'gmail','fixture@example.test','test')").bind(account).execute(&pool).await?;
    sqlx::query("insert into threads(id,account_id,provider_thread_id,last_message_at) values(?1,?2,'fixture','2026-01-01T00:00:00.000000Z')").bind(thread).bind(account).execute(&pool).await?;
    let fixtures = [
        ("Original".to_owned(), None, None),
        (String::new(), Some(String::new()), Some(String::new())),
        (
            "Unicode 雪 🦀 \"quoted\" \\ slash\n\t\0".into(),
            Some("<p>HTML &amp; é</p>".to_owned()),
            Some("Plain\r\ntext".to_owned()),
        ),
        (
            "large body\n".repeat(30_000),
            None,
            Some("Reader text".to_owned()),
        ),
    ];
    let mut expected = std::collections::HashMap::new();
    for (text, html, plain) in fixtures {
        let id = Uuid::new_v4();
        sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,received_at,direction,text_body,html_body) values(?1,?2,?3,?1,'2026-01-01T00:00:00.000000Z','inbound',?4,?5)").bind(id).bind(account).bind(thread).bind(&text).bind(&html).execute(&pool).await?;
        if let Some(plain) = &plain {
            sqlx::query("insert into classifications(message_id,model_tier,reasoning,model,prompt_version,plain_text) values(?1,1,'test','test','test',?2)").bind(id).bind(plain).execute(&pool).await?;
        }
        let input = format!("[{}, {}, {}]", json!(text), json!(html), json!(plain));
        expected.insert(
            id.to_string(),
            format!("{:x}", Sha256::digest(input.as_bytes())),
        );
    }
    let mut cache = BodyVersionCache::default();
    for bodies in [false, false, true] {
        let inventory = repo
            .replica_inventory_cached(None, bodies, &mut cache)
            .await?;
        assert_eq!(inventory.messages.len(), expected.len());
        for message in inventory.messages {
            assert_eq!(
                message["bodyVersion"].as_str().unwrap(),
                expected[message["id"].as_str().unwrap()]
            );
            if !bodies {
                assert_eq!(message["textBody"], "");
                assert_eq!(message["htmlBody"], json!(null));
                assert_eq!(message["plainText"], json!(null));
            }
        }
    }
    assert_eq!(cache.computed(), 0);
    Ok(())
}

#[tokio::test]
async fn cached_body_versions_follow_committed_mvcc_rows_without_timestamp_assumptions()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("body-versions.sqlite");
    let url = path.to_str().unwrap();
    let pool = db::pool(url, true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool.clone());
    let account = Uuid::new_v4();
    let thread = Uuid::new_v4();
    let id = Uuid::new_v4();
    let ids = [id];
    sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values(?1,'microsoft',?2,'test')").bind(account).bind(format!("{account}@test")).execute(&pool).await?;
    sqlx::query("insert into threads(id,account_id,provider_thread_id,last_message_at) values(?1,?2,?1,strftime('%Y-%m-%dT%H:%M:%f000Z','now'))").bind(thread).bind(account).execute(&pool).await?;
    sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,received_at,text_body,direction) values(?1,?2,?3,?1,strftime('%Y-%m-%dT%H:%M:%f000Z','now'),'Original','inbound')").bind(id).bind(account).bind(thread).execute(&pool).await?;
    let mut cache = BodyVersionCache::default();
    let first = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 1);
    let same = repo
        .replica_inventory_cached(Some(&ids), true, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 0);
    assert_eq!(
        same.messages[0]["bodyVersion"],
        first.messages[0]["bodyVersion"]
    );
    assert_eq!(same.messages[0]["textBody"], "Original");
    sqlx::query("update messages set read=true where id=?1")
        .bind(id)
        .execute(&pool)
        .await?;
    let header = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 1);
    assert_eq!(
        header.messages[0]["bodyVersion"],
        first.messages[0]["bodyVersion"]
    );
    let mut tx = pool.begin().await?;
    sqlx::query("update messages set text_body='Uncommitted' where id=?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let during = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 0);
    assert_eq!(
        during.messages[0]["bodyVersion"],
        first.messages[0]["bodyVersion"]
    );
    tx.rollback().await?;
    sqlx::query("update messages set text_body='Changed without updated_at' where id=?1")
        .bind(id)
        .execute(&pool)
        .await?;
    let changed = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 1);
    assert_ne!(
        changed.messages[0]["bodyVersion"],
        first.messages[0]["bodyVersion"]
    );
    sqlx::query("insert into classifications(message_id,model_tier,reasoning,model,prompt_version,plain_text) values(?1,1,'test','test','test','Cleaned')").bind(id).execute(&pool).await?;
    let classified = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_ne!(
        classified.messages[0]["bodyVersion"],
        changed.messages[0]["bodyVersion"]
    );
    let direct = repo.replica_inventory(Some(&ids), false).await?;
    assert_eq!(classified.messages, direct.messages);
    pool.close().await;
    assert!(
        repo.replica_inventory_cached(Some(&ids), false, &mut cache)
            .await
            .is_err()
    );
    assert_eq!(cache.computed(), 1);
    let pool = db::pool(url, true).await?;
    let repo = Repository(pool.clone());
    let resumed = repo
        .replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 0);
    assert_eq!(resumed.messages, direct.messages);
    cache.clear();
    assert_eq!(
        repo.replica_inventory_cached(Some(&[]), false, &mut cache)
            .await?
            .messages
            .len(),
        0
    );
    assert_eq!(cache.computed(), 0);
    repo.replica_inventory_cached(Some(&ids), false, &mut cache)
        .await?;
    assert_eq!(cache.computed(), 1);
    sqlx::query("delete from messages where id=?1")
        .bind(id)
        .execute(&pool)
        .await?;
    assert!(
        repo.replica_inventory_cached(Some(&ids), false, &mut cache)
            .await?
            .messages
            .is_empty()
    );
    sqlx::query("delete from threads where id=?1")
        .bind(thread)
        .execute(&pool)
        .await?;
    sqlx::query("delete from accounts where id=?1")
        .bind(account)
        .execute(&pool)
        .await?;
    Ok(())
}
