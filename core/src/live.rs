use anyhow::Result;
use sqlx::{Executor, Sqlite};

pub const CHANNEL: &str = "sent_mailbox_changed";

pub async fn session_revoked(pool: &sqlx::PgPool, session: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>("select exists(select 1 from worker_state where name=$1 and (metadata->>'expires')::bigint > extract(epoch from now()))")
        .bind(format!("session-revoked:{session}"))
        .fetch_one(pool).await?)
}

pub async fn revoke_session(pool: &sqlx::PgPool, session: &str, expires: i64) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("delete from worker_state where name like 'session-revoked:%' and (metadata->>'expires')::bigint <= extract(epoch from now())")
        .execute(&mut *tx).await?;
    sqlx::query("insert into worker_state(name,metadata) values($1,$2) on conflict(name) do update set metadata=excluded.metadata")
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
    sqlx::query("insert into sent_live_revocations(session,expires) values (?1,?2) on conflict(session) do update set expires=excluded.expires")
        .bind(session).bind(expires)
        .execute(executor)
        .await?;
    Ok(())
}
