use anyhow::Result;
use sqlx::{Executor, Postgres};

pub const CHANNEL: &str = "sent_mailbox_changed";

pub async fn notify_changed<'e>(executor: impl Executor<'e, Database = Postgres>) -> Result<()> {
    sqlx::query("select pg_notify($1,'changed')")
        .bind(CHANNEL)
        .execute(executor)
        .await?;
    Ok(())
}

pub async fn notify_logout<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    session: &str,
    expires: i64,
) -> Result<()> {
    sqlx::query("select pg_notify($1,$2)")
        .bind(CHANNEL)
        .bind(serde_json::json!({"logout": session, "expires": expires}).to_string())
        .execute(executor)
        .await?;
    Ok(())
}
