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
    sqlx::query("update sent_live_signal set revision=revision+1 where id=1")
        .execute(executor)
        .await?;
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
