use anyhow::{Context, Result, bail};
use chrono::{Duration, TimeZone, Utc};
use sent_core::db::Uuid;
use sent_core::{config::Config, db};
use serde_json::json;

fn id(namespace: u128, index: usize) -> Uuid {
    Uuid::from_u128(0x5e170000_0000_4000_8000_000000000000 | (namespace << 32) | index as u128)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut count = 3000usize;
    let mut reset = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reset" => reset = true,
            "--messages" => {
                count = args
                    .next()
                    .context("--messages requires a count")?
                    .parse()?
            }
            "--help" | "-h" => {
                println!(
                    "sent-seed [--reset] [--messages N]\nRequires SENT_FAKE_PROVIDERS=true and a local database. Reset removes ONLY the deterministic fake accounts."
                );
                return Ok(());
            }
            _ => bail!("Unknown argument: {arg}"),
        }
    }
    let config = Config::from_env()?;
    if !config.fake_providers {
        bail!("Seeding requires SENT_FAKE_PROVIDERS=true");
    }
    let pool = db::pool(&config.database_path, true).await?;
    db::migrate(&pool, &config.migrations_path).await?;
    seed(&pool, count, reset).await?;
    let conversations = if count == 0 {
        0
    } else {
        (count * 2 / 5).max(1)
    };
    println!("Seeded 2 fake accounts, {count} messages, {conversations} conversations");
    pool.close().await;
    Ok(())
}

async fn seed(pool: &sqlx::SqlitePool, count: usize, reset: bool) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if reset {
        sqlx::query("delete from accounts where id in (select value from json_each(?1)) and email in ('owner@gmail.example','owner@microsoft.example')")
            .bind(json!(vec![id(1, 0), id(1, 1)])).execute(&mut *tx).await?;
    }
    let epoch = Utc.with_ymd_and_hms(2025, 1, 15, 12, 0, 0).unwrap();
    for (index, provider) in ["gmail", "microsoft"].iter().enumerate() {
        sqlx::query("insert into accounts(id,provider,email,display_name,encrypted_credentials,created_at,updated_at,last_synced_at) values(?1,?2,?3,?4,'sent-fake-provider:no-live-credentials',?5,?5,?5)")
            .bind(id(1, index)).bind(provider).bind(format!("owner@{provider}.example")).bind(format!("Fake {provider} mailbox"))
            .bind(sent_core::db::timestamp(epoch + Duration::seconds(index as i64))).execute(&mut *tx).await.context("Fake accounts already exist; pass --reset to replace them")?;
        sqlx::query("insert into sync_cursors(account_id,cursor,backfill_complete,last_successful_at,updated_at) values(?1,'sent-fake-provider',true,?2,?2)")
            .bind(id(1, index)).bind(sent_core::db::timestamp(epoch)).execute(&mut *tx).await?;
    }
    let conversations = if count == 0 {
        0
    } else {
        (count * 2 / 5).max(1)
    };
    for thread in 0..conversations {
        let latest = thread + ((count - 1 - thread) / conversations) * conversations;
        sqlx::query("insert into threads(id,account_id,provider_thread_id,subject,last_message_at,created_at,updated_at) values(?1,?2,?3,?4,?5,?6,?6)")
            .bind(id(2, thread)).bind(id(1, thread % 2)).bind(format!("fake-thread-{thread:05}"))
            .bind(format!("{} #{thread:04}", ["Project update", "Invoice review", "Weekend plans", "Newsletter", "Meeting invitation", "Travel booking"][thread % 6]))
            .bind(sent_core::db::timestamp(epoch + Duration::minutes(latest as i64))).bind(sent_core::db::timestamp(epoch)).execute(&mut *tx).await?;
    }
    for index in 0..count {
        let thread = index % conversations;
        let provider = ["gmail", "microsoft"][thread % 2];
        let outbound = index % 5 == 0;
        let owner =
            json!([{ "name": "Mailbox Owner", "address": format!("owner@{provider}.example") }]);
        let contact = json!([{ "name": format!("Contact {}", index % 31), "address": format!("contact{}@example.test", index % 31) }]);
        let body = format!(
            "Hello! This is deterministic fake message {index}.\n\nReview [the project brief](https://example.test/projects/{thread}) and reply by Friday.\n\nThanks,\nContact {}",
            index % 31
        );
        let attachments = if index % 11 == 0 {
            json!([{ "id": format!("fake-attachment-{index}"), "filename": format!("report-{index}.txt"), "contentType": "text/plain", "size": 48, "inline": false, "contentId": null }])
        } else {
            json!([])
        };
        let received = epoch + Duration::minutes(index as i64);
        sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,internet_message_id,subject,from_addresses,to_addresses,sent_at,received_at,snippet,text_body,attachments,direction,read,flagged,archived,deleted,native_state,created_at,updated_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10,?11,?12,?13,?14,?15,?16,?17,'{\"fake\":true}',?18,?18)")
            .bind(id(3, index)).bind(id(1, thread % 2)).bind(id(2, thread))
            .bind(format!("fake-message-{index:06}")).bind(format!("<fake-{index}@example.test>"))
            .bind(format!("{} #{thread:04}", ["Project update", "Invoice review", "Weekend plans", "Newsletter", "Meeting invitation", "Travel booking"][thread % 6]))
            .bind(if outbound { &owner } else { &contact }).bind(if outbound { &contact } else { &owner })
            .bind(sent_core::db::timestamp(received)).bind(format!("Fake message {index}: review the project brief and reply by Friday."))
            .bind(&body).bind(attachments).bind(if outbound { "outbound" } else { "inbound" })
            .bind(index % 3 != 0).bind(index % 17 == 0).bind(index % 7 == 0).bind(index % 29 == 0)
            .bind(sent_core::db::timestamp(epoch)).execute(&mut *tx).await?;
        if index % 7 != 0 {
            let tier = (index % 3 + 1) as i32;
            sqlx::query("insert into classifications(message_id,model_tier,reasoning,plain_text,summary,model,prompt_version,classified_at,updated_at) values(?1,?2,?3,?4,?5,'fake-model','fake-v1',?6,?6)")
                .bind(id(3, index)).bind(tier).bind(format!("Fixture classification: priority tier {tier}; no model was called."))
                .bind(&body).bind(format!("Review fake project {thread} and reply by Friday."))
                .bind(sent_core::db::timestamp(epoch)).execute(&mut *tx).await?;
        }
    }
    sent_core::live::notify_changed(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sent_core::repository::{BodyVersionCache, Repository};

    #[tokio::test]
    async fn seed_and_reset_are_journaled_even_alongside_metadata_writes() -> Result<()> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        db::migrate(
            &pool,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
        )
        .await?;
        let repo = Repository(pool.clone());
        let mut cache = BodyVersionCache::default();
        let first = repo.replica_update(None, &mut cache).await?.unwrap();
        seed(&pool, 2, false).await?;
        repo.heartbeat("seed-test", json!({})).await?;
        let inserted = repo
            .replica_update(Some(first.mark), &mut cache)
            .await?
            .unwrap();
        assert!(inserted.full);
        assert_eq!(inserted.inventory.messages.len(), 2);
        assert_eq!(inserted.inventory.accounts.len(), 2);
        assert!(seed(&pool, 1, false).await.is_err());
        assert!(
            repo.replica_update(Some(inserted.mark), &mut cache)
                .await?
                .is_none()
        );
        seed(&pool, 0, true).await?;
        repo.heartbeat("seed-test", json!({})).await?;
        let reset = repo
            .replica_update(Some(inserted.mark), &mut cache)
            .await?
            .unwrap();
        assert!(reset.full);
        assert!(reset.inventory.messages.is_empty());
        pool.close().await;
        Ok(())
    }
}
