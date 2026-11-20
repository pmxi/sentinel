use anyhow::Result;
use sent_core::{
    db::{self, Uuid},
    repository::Repository,
};
use serde_json::json;

#[tokio::test]
async fn imported_mutations_are_claimed_in_creation_order_not_insertion_order() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pool = db::pool(
        directory.path().join("outbox.sqlite").to_str().unwrap(),
        true,
    )
    .await?;
    db::migrate(
        &pool,
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
    )
    .await?;
    let repo = Repository(pool);
    let owner = repo
        .upsert_account("gmail", "fixture@example.test", "Fixture", "test")
        .await?;
    let ids = [
        Uuid::from_u128(1),
        Uuid::from_u128(2),
        Uuid::from_u128(3),
        Uuid::from_u128(4),
    ];
    for (id, created) in [
        (ids[3], "2026-03-01"),
        (ids[2], "2026-02-01"),
        (ids[0], "2026-01-01"),
        (ids[1], "2026-02-01"),
    ] {
        sqlx::query("insert into mutation_outbox(id,idempotency_key,account_id,action,created_at,next_attempt_at) values(?1,?1,?2,'archive',?3,'2000-01-01T00:00:00.000000Z')")
            .bind(id).bind(owner).bind(format!("{created}T00:00:00.000000Z")).execute(&repo.0).await?;
    }
    assert!(repo.claim_mutations(0).await?.is_empty());
    let first = repo.claim_mutations(3).await?;
    assert_eq!(
        first.iter().map(|v| v["id"].clone()).collect::<Vec<_>>(),
        vec![json!(ids[0]), json!(ids[1]), json!(ids[2])]
    );
    let last = repo.claim_mutations(3).await?;
    assert_eq!(last.len(), 1);
    assert_eq!(last[0]["id"], json!(ids[3]));
    assert!(repo.claim_mutations(3).await?.is_empty());
    Ok(())
}
