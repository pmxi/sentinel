use anyhow::Result;
use sqlx::{Executor, Sqlite};

pub async fn session_revoked(pool: &sqlx::SqlitePool, session: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>("select exists(select 1 from worker_state where name=?1 and cast(json_extract(metadata,'$.expires') as integer) > cast(strftime('%s','now') as integer))")
        .bind(format!("session-revoked:{session}"))
        .fetch_one(pool).await?)
}

pub async fn revoke_session(pool: &sqlx::SqlitePool, session: &str, expires: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("delete from worker_state where name like 'session-revoked:%' and cast(json_extract(metadata,'$.expires') as integer) <= cast(strftime('%s','now') as integer)")
        .execute(&mut *tx).await?;
    sqlx::query("insert into worker_state(name,metadata) values(?1,?2) on conflict(name) do update set metadata=excluded.metadata")
        .bind(format!("session-revoked:{session}"))
        .bind(serde_json::json!({"expires":expires}))
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn notify_changed<'e>(executor: impl Executor<'e, Database = Sqlite>) -> Result<()> {
    sqlx::query("insert into sent_live_changes(kind) values('full')")
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn notify_messages<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    ids: &[crate::db::Uuid],
) -> Result<()> {
    sqlx::query("insert into sent_live_changes(kind,message_id) select 'message',value from json_each(?1) union all select 'metadata',null where json_array_length(?1)=0")
        .bind(serde_json::json!(ids)).execute(executor).await?;
    Ok(())
}

pub async fn notify_threads<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    ids: &[crate::db::Uuid],
) -> Result<()> {
    sqlx::query(
        "insert into sent_live_changes(kind,thread_id) select 'thread',value from json_each(?1)",
    )
    .bind(serde_json::json!(ids))
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn notify_mutation<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    id: crate::db::Uuid,
) -> Result<()> {
    sqlx::query("insert into sent_live_changes(kind,message_id) select case when message_id is null then 'metadata' else 'message' end,message_id from mutation_outbox where id=?1")
        .bind(id).execute(executor).await?;
    Ok(())
}

pub async fn notify_provider_messages<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    account: crate::db::Uuid,
    ids: &[String],
) -> Result<()> {
    sqlx::query("insert into sent_live_changes(kind,message_id) select 'message',id from messages where account_id=?1 and provider_message_id in (select value from json_each(?2))")
        .bind(account).bind(serde_json::json!(ids)).execute(executor).await?;
    Ok(())
}

pub async fn notify_logout<'e>(
    executor: impl Executor<'e, Database = Sqlite>,
    session: &str,
    expires: i64,
) -> Result<()> {
    sqlx::query("insert into worker_state(name,metadata) values(?1,?2) on conflict(name) do update set metadata=excluded.metadata")
        .bind(format!("session-revoked:{session}")).bind(serde_json::json!({"expires":expires}))
        .execute(executor)
        .await?;
    Ok(())
}
