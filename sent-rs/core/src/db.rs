use anyhow::Result;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::path::Path;

pub async fn pool(database_url: &str, test: bool) -> Result<PgPool> {
    Ok(PgPoolOptions::new()
        .max_connections(if test { 2 } else { 12 })
        .connect(database_url)
        .await?)
}

pub async fn migrate(pool: &PgPool, directory: &Path) -> Result<()> {
    let mut connection = pool.acquire().await?;
    sqlx::query("select pg_advisory_lock(89372411)")
        .execute(&mut *connection)
        .await?;
    let result = async {
        sqlx::query("create table if not exists sent_migrations (filename text primary key, applied_at timestamptz not null default now())").execute(&mut *connection).await?;
        let applied = sqlx::query("select filename from sent_migrations").fetch_all(&mut *connection).await?.into_iter().map(|r| r.get::<String, _>("filename")).collect::<Vec<_>>();
        let mut entries = tokio::fs::read_dir(directory).await?;
        let mut files = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_type().await?.is_file() && entry.path().extension().is_some_and(|x| x == "sql") {
                files.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        files.sort();
        for file in files {
            if applied.contains(&file) { continue; }
            let sql = tokio::fs::read_to_string(directory.join(&file)).await?;
            let mut transaction = sqlx::Connection::begin(&mut *connection).await?;
            sqlx::raw_sql(&sql).execute(&mut *transaction).await?;
            sqlx::query("insert into sent_migrations(filename) values ($1)").bind(&file).execute(&mut *transaction).await?;
            transaction.commit().await?;
            println!("Applied {file}");
        }
        Ok::<_, anyhow::Error>(())
    }.await;
    let unlocked = sqlx::query("select pg_advisory_unlock(89372411)")
        .execute(&mut *connection)
        .await;
    if unlocked.is_err() {
        connection.close().await?;
    }
    result
}
