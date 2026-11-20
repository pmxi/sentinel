use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use sent_core::{
    db,
    repository::{ListInput, Repository, SearchInput},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{
    Connection, Row,
    postgres::{PgConnectOptions, PgConnection},
    sqlite::SqliteRow,
};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

const TABLES: &[&str] = &[
    "accounts",
    "sync_cursors",
    "threads",
    "messages",
    "provider_containers",
    "message_containers",
    "classifications",
    "classification_failures",
    "embeddings",
    "drafts",
    "mutation_outbox",
    "worker_state",
];

#[derive(Debug, PartialEq, serde::Serialize)]
enum Cell {
    Null,
    Text(String),
    Integer(i64),
    Blob(Vec<u8>),
}

fn convert(value: Option<&str>, kind: &str) -> Result<Cell> {
    let Some(value) = value else {
        return Ok(Cell::Null);
    };
    Ok(match kind {
        "uuid" => Cell::Text(value.parse::<uuid::Uuid>()?.to_string()),
        "timestamptz" => Cell::Text(db::timestamp(value.parse::<DateTime<Utc>>()?)),
        "jsonb" | "json" => Cell::Text(serde_json::from_str::<Value>(value)?.to_string()),
        "bool" => Cell::Integer(match value {
            "true" | "t" => 1,
            "false" | "f" => 0,
            _ => anyhow::bail!("Invalid boolean"),
        }),
        "int2" | "int4" | "int8" => Cell::Integer(value.parse()?),
        "vector" => Cell::Blob(db::embedding_blob(&serde_json::from_str::<Vec<f64>>(
            value,
        )?)?),
        _ => Cell::Text(value.to_owned()),
    })
}

fn sqlite_cells(row: &SqliteRow, kinds: &[String]) -> Result<Vec<Cell>> {
    kinds
        .iter()
        .enumerate()
        .map(|(i, kind)| {
            Ok(match kind.as_str() {
                "bool" | "int2" | "int4" | "int8" => row
                    .try_get::<Option<i64>, _>(i)?
                    .map_or(Cell::Null, Cell::Integer),
                "vector" => row
                    .try_get::<Option<Vec<u8>>, _>(i)?
                    .map_or(Cell::Null, Cell::Blob),
                _ => row
                    .try_get::<Option<String>, _>(i)?
                    .map_or(Cell::Null, Cell::Text),
            })
        })
        .collect()
}

async fn copy(source: &mut PgConnection, target: &sqlx::SqlitePool) -> Result<()> {
    let mut dest = target.begin_with("BEGIN IMMEDIATE").await?;
    for table in TABLES {
        let started = Instant::now();
        let columns = sqlx::query(&format!("pragma table_info({table})"))
            .fetch_all(&mut *dest)
            .await?;
        let names: Vec<String> = columns.iter().map(|r| r.get("name")).collect();
        let mut keys: Vec<(i64, String)> = columns
            .iter()
            .filter_map(|r| {
                let pk: i64 = r.get("pk");
                (pk > 0).then(|| (pk, r.get("name")))
            })
            .collect();
        keys.sort();
        let order = keys
            .iter()
            .map(|(_, name)| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(",");
        let pg_order = keys
            .iter()
            .map(|(_, name)| format!("\"{name}\"::text collate \"C\""))
            .collect::<Vec<_>>()
            .join(",");
        let mut kinds = Vec::new();
        for name in &names {
            kinds.push(sqlx::query_scalar::<_, String>("select udt_name from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2")
                .bind(table).bind(name).fetch_one(&mut *source).await?);
        }
        let fields = names
            .iter()
            .map(|n| format!("\"{n}\""))
            .collect::<Vec<_>>()
            .join(",");
        let projection = names
            .iter()
            .zip(&kinds)
            .map(|(n, kind)| {
                if kind == "timestamptz" {
                    format!(
                        "to_char(\"{n}\" at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
                    )
                } else {
                    format!("\"{n}\"::text")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        sqlx::query(&format!("declare import_rows no scroll cursor for select json_build_array({projection}) as data from public.{table} order by {pg_order}"))
            .execute(&mut *source).await?;
        let placeholders = vec!["?"; names.len()].join(",");
        let insert = format!("insert into {table}({fields}) values ({placeholders})");
        let mut source_hash = Sha256::new();
        let mut count = 0i64;
        loop {
            let rows = sqlx::query("fetch forward 100 from import_rows")
                .fetch_all(&mut *source)
                .await?;
            if rows.is_empty() {
                break;
            }
            for row in rows {
                let values: Vec<Option<String>> =
                    serde_json::from_value(row.try_get::<Value, _>("data")?)?;
                let cells = values
                    .iter()
                    .zip(&kinds)
                    .map(|(v, k)| convert(v.as_deref(), k))
                    .collect::<Result<Vec<_>>>()?;
                source_hash.update(serde_json::to_vec(&cells)?);
                let mut query = sqlx::query(&insert);
                for cell in cells {
                    query = match cell {
                        Cell::Null => query.bind(None::<String>),
                        Cell::Text(v) => query.bind(v),
                        Cell::Integer(v) => query.bind(v),
                        Cell::Blob(v) => query.bind(v),
                    };
                }
                query.execute(&mut *dest).await?;
                count += 1;
            }
        }
        sqlx::query("close import_rows")
            .execute(&mut *source)
            .await?;
        let expected: i64 = sqlx::query_scalar(&format!("select count(*) from public.{table}"))
            .fetch_one(&mut *source)
            .await?;
        let actual: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&mut *dest)
            .await?;
        ensure!(count == expected && count == actual, "Row count mismatch");
        let mut target_hash = Sha256::new();
        let mut offset = 0i64;
        loop {
            let rows = sqlx::query(&format!(
                "select {fields} from {table} order by {order} limit 100 offset ?"
            ))
            .bind(offset)
            .fetch_all(&mut *dest)
            .await?;
            if rows.is_empty() {
                break;
            }
            offset += rows.len() as i64;
            for row in rows {
                target_hash.update(serde_json::to_vec(&sqlite_cells(&row, &kinds)?)?);
            }
        }
        ensure!(
            source_hash.finalize() == target_hash.finalize(),
            "Content mismatch"
        );
        println!(
            "{table}: {count} rows verified ({:.3}s)",
            started.elapsed().as_secs_f64()
        );
    }
    let integrity: String = sqlx::query_scalar("pragma integrity_check")
        .fetch_one(&mut *dest)
        .await?;
    ensure!(integrity == "ok", "Integrity check failed");
    ensure!(
        sqlx::query("pragma foreign_key_check")
            .fetch_all(&mut *dest)
            .await?
            .is_empty(),
        "Foreign key check failed"
    );
    let messages: i64 = sqlx::query_scalar("select count(*) from messages")
        .fetch_one(&mut *dest)
        .await?;
    let indexed: i64 = sqlx::query_scalar("select count(*) from messages_search")
        .fetch_one(&mut *dest)
        .await?;
    ensure!(messages == indexed, "FTS count mismatch");
    dest.commit().await?;
    println!("integrity_check=ok foreign_key_check=ok FTS={indexed}");
    Ok(())
}

async fn import(path: &Path) -> Result<()> {
    ensure!(!path.try_exists()?, "Target already exists");
    let temp = PathBuf::from(format!("{}.tmp", path.display()));
    let reservation = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        reservation.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    drop(reservation);
    let started = Instant::now();
    let result: Result<()> = async {
        let options: PgConnectOptions = std::env::var("DATABASE_URL")?.parse()?;
        let mut source =
            PgConnection::connect_with(&options.options([("default_transaction_read_only", "on")]))
                .await?;
        sqlx::query("begin isolation level repeatable read read only")
            .execute(&mut source)
            .await?;
        sqlx::query("set local timezone='UTC'")
            .execute(&mut source)
            .await?;
        let target = db::pool(temp.to_str().context("Invalid path")?, true).await?;
        let migrated = db::migrate(
            &target,
            &std::env::var_os("MIGRATIONS_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../migrations")),
        )
        .await;
        let copied = match migrated {
            Ok(()) => copy(&mut source, &target).await,
            Err(error) => Err(error),
        };
        target.close().await;
        copied?;
        sqlx::query("rollback").execute(&mut source).await?;
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            &temp,
            rustix::fs::CWD,
            path,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
        println!("Import complete ({:.3}s)", started.elapsed().as_secs_f64());
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", temp.display()));
        }
    }
    result
}

async fn check(path: &Path) -> Result<()> {
    let started = Instant::now();
    let pool = db::read_only_pool(path).await?;
    let repo = Repository(pool.clone());
    for view in [
        "inbox",
        "l1",
        "l2",
        "l3",
        "unclassified",
        "all",
        "sent",
        "trash",
    ] {
        let start = Instant::now();
        let page = repo
            .list_messages(ListInput {
                view: Some(view.into()),
                limit: Some(10),
                ..Default::default()
            })
            .await?;
        println!(
            "view {view}: {} threads ({:.3}s)",
            page["messages"].as_array().context("Invalid list")?.len(),
            start.elapsed().as_secs_f64()
        );
    }
    let top = sqlx::query("select id,thread_id,deleted from messages where not tombstone order by received_at desc limit 1").fetch_optional(&pool).await?;
    if let Some(row) = top {
        let id = row.try_get("id")?;
        let detail = repo
            .get_thread_with_state(row.try_get("thread_id")?, row.try_get("deleted")?, true)
            .await?;
        repo.get_message_with_state(id, true).await?;
        repo.message_states(&[id]).await?;
        println!(
            "thread: {} messages",
            detail.as_array().context("Invalid thread")?.len()
        );
    }
    for term in ["the", "meeting"] {
        let input: SearchInput = serde_json::from_value(serde_json::json!({"q":term,"limit":10}))?;
        let hits = repo.search(&input, None).await?;
        println!(
            "lexical {term}: {} hits",
            hits["messages"].as_array().context("Invalid search")?.len()
        );
    }
    if let Some(blob) = sqlx::query_scalar::<_, Vec<u8>>("select embedding from embeddings limit 1")
        .fetch_optional(&pool)
        .await?
    {
        ensure!(blob.len() == 12288, "Invalid stored embedding");
        let vector = blob
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b) as f64)
            .collect();
        let input = serde_json::from_value(serde_json::json!({"q":"meeting","limit":10}))?;
        let hits = repo.search(&input, Some(vector)).await?;
        println!(
            "hybrid: {} hits",
            hits["messages"].as_array().context("Invalid search")?.len()
        );
    } else {
        println!("hybrid: 0 stored embeddings");
    }
    let inventory = repo.replica_inventory(None, false).await?;
    let ids = inventory
        .messages
        .iter()
        .take(10)
        .map(|m| {
            m["id"]
                .as_str()
                .context("Invalid replica ID")?
                .parse()
                .map_err(Into::into)
        })
        .collect::<Result<Vec<_>>>()?;
    repo.replica_inventory(Some(&ids), true).await?;
    repo.list_accounts().await?;
    repo.list_drafts().await?;
    repo.health().await?;
    println!(
        "replica: {} messages, {} accounts",
        inventory.messages.len(),
        inventory.accounts.len()
    );
    pool.close().await;
    println!(
        "Read-only check complete ({:.3}s)",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [flag, path] if flag == "--check" => check(Path::new(path)).await,
        [path] if path != "--check" => import(Path::new(path)).await,
        _ => {
            eprintln!("Usage: sent-import-postgres <new.sqlite> | --check <existing.sqlite>");
            return std::process::ExitCode::FAILURE;
        }
    };
    if result.is_err() {
        eprintln!(
            "Import/check failed: source/target unavailable, invalid data, or verification mismatch. No sensitive diagnostics printed."
        );
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversions() {
        assert_eq!(convert(None, "text").unwrap(), Cell::Null);
        assert_eq!(
            convert(Some("2026-01-02T03:04:05.123456Z"), "timestamptz").unwrap(),
            Cell::Text("2026-01-02T03:04:05.123456Z".into())
        );
        assert_eq!(convert(Some("t"), "bool").unwrap(), Cell::Integer(1));
        assert!(convert(Some("[]"), "vector").is_err());
        assert!(convert(Some("invalid"), "jsonb").is_err());
    }
}
