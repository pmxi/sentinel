use anyhow::Result;
use sent_core::{
    db::{self, Uuid},
    live,
    repository::{BodyVersionCache, Repository},
};
use serde_json::json;

#[tokio::test]
async fn incremental_inventory_is_transactional_selective_and_recovers_gaps() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("incremental.sqlite");
    let pool = db::pool(path.to_str().unwrap(), true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool.clone());
    let account = Uuid::new_v4();
    let thread = Uuid::new_v4();
    sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values(?1,'gmail','incremental@example.test','fake')").bind(account).execute(&pool).await?;
    sqlx::query("insert into threads(id,account_id,provider_thread_id,last_message_at) values(?1,?2,'test','2026-01-01T00:00:00Z')").bind(thread).bind(account).execute(&pool).await?;
    let ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    for id in ids {
        sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,text_body,received_at,direction) values(?1,?2,?3,?1,'body','2026-01-01T00:00:00Z','inbound')").bind(id).bind(account).bind(thread).execute(&pool).await?;
    }
    let mut cache = BodyVersionCache::default();
    let first = repo.replica_update(None, &mut cache).await?.unwrap();
    assert!(first.full);
    assert_eq!(first.inventory.messages.len(), 3);
    assert_eq!(cache.computed(), 3);
    let mut mark = first.mark;
    assert!(repo.replica_update(Some(mark), &mut cache).await?.is_none());

    let writer = db::pool(path.to_str().unwrap(), true).await?;
    let mut tx = writer.begin().await?;
    sqlx::query("update messages set read=true where id=?1")
        .bind(ids[0])
        .execute(&mut *tx)
        .await?;
    live::notify_messages(&mut *tx, &[ids[0]]).await?;
    assert!(repo.replica_update(Some(mark), &mut cache).await?.is_none());
    tx.rollback().await?;
    assert!(repo.replica_update(Some(mark), &mut cache).await?.is_none());
    let mut tx = writer.begin().await?;
    sqlx::query("update messages set read=true where id=?1")
        .bind(ids[0])
        .execute(&mut *tx)
        .await?;
    live::notify_messages(&mut *tx, &[ids[0]]).await?;
    tx.commit().await?;
    let change = repo.replica_update(Some(mark), &mut cache).await?.unwrap();
    assert!(!change.full);
    assert_eq!(change.ids, vec![ids[0]]);
    assert_eq!(change.inventory.messages.len(), 1);
    assert_eq!(change.inventory.messages[0]["read"], true);
    assert_eq!(cache.computed(), 1);
    mark = change.mark;
    assert!(repo.replica_update(Some(mark), &mut cache).await?.is_none());

    let mut tx = writer.begin().await?;
    sqlx::query("delete from messages where id=?1")
        .bind(ids[0])
        .execute(&mut *tx)
        .await?;
    live::notify_messages(&mut *tx, &[ids[0]]).await?;
    tx.commit().await?;
    let deletion = repo.replica_update(Some(mark), &mut cache).await?.unwrap();
    assert_eq!(deletion.ids, vec![ids[0]]);
    assert!(deletion.inventory.messages.is_empty());
    mark = deletion.mark;

    let mut tx = writer.begin().await?;
    sqlx::query("update messages set archived=true where thread_id=?1")
        .bind(thread)
        .execute(&mut *tx)
        .await?;
    live::notify_threads(&mut *tx, &[thread]).await?;
    tx.commit().await?;
    let group = repo.replica_update(Some(mark), &mut cache).await?.unwrap();
    assert_eq!(group.ids.len(), 2);
    assert_eq!(group.inventory.messages.len(), 2);
    assert!(
        group
            .inventory
            .messages
            .iter()
            .all(|r| r["archived"] == json!(true))
    );
    mark = group.mark;

    for _ in 0..3 {
        live::notify_messages(&writer, &[]).await?;
    }
    sqlx::query("delete from sent_live_changes where revision<(select max(revision) from sent_live_changes)").execute(&writer).await?;
    let gap = repo.replica_update(Some(mark), &mut cache).await?.unwrap();
    assert!(gap.full);
    assert_eq!(gap.inventory.messages.len(), 2);
    mark = gap.mark;
    assert!(repo.replica_update(Some(mark), &mut cache).await?.is_none());

    live::notify_changed(&writer).await?;
    let unknown = repo.replica_update(Some(mark), &mut cache).await?.unwrap();
    assert!(unknown.full);
    mark = unknown.mark;
    sqlx::query("update sent_live_signal set revision=revision+1")
        .execute(&writer)
        .await?;
    assert!(
        repo.replica_update(Some(mark), &mut cache)
            .await?
            .unwrap()
            .full
    );
    writer.close().await;
    pool.close().await;
    Ok(())
}

#[tokio::test]
async fn empty_inventory_and_account_only_changes_are_replayable() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let pool = db::pool(dir.path().join("empty.sqlite").to_str().unwrap(), true).await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool.clone());
    let mut cache = BodyVersionCache::default();
    let empty = repo.replica_update(None, &mut cache).await?.unwrap();
    assert!(empty.inventory.messages.is_empty());
    assert!(
        repo.replica_update(Some(empty.mark), &mut cache)
            .await?
            .is_none()
    );
    repo.heartbeat("test-worker", json!({"active":true}))
        .await?;
    let metadata = repo
        .replica_update(Some(empty.mark), &mut cache)
        .await?
        .unwrap();
    assert!(!metadata.full);
    assert!(metadata.ids.is_empty());
    assert!(metadata.inventory.messages.is_empty());
    pool.close().await;
    Ok(())
}
