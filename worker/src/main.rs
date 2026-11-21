use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use fs2::FileExt;
use sent_core::db::Uuid;
use sent_core::{config::Config, db, repository::Repository, services::Services};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration as StdDuration,
};
use tokio::{
    task::JoinSet,
    time::{MissedTickBehavior, interval},
};

#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
enum Kind {
    Sync,
    Classify,
    Embed,
}
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize, Deserialize)]
struct Key {
    kind: Kind,
    id: Uuid,
}
#[derive(Clone, Serialize, Deserialize)]
struct Job {
    key: Key,
    attempt: u8,
    next_at: DateTime<Utc>,
    // Kept for rollback compatibility with older workers.
    created_at: DateTime<Utc>,
}

impl Job {
    fn new(kind: Kind, id: Uuid) -> Self {
        Self {
            key: Key { kind, id },
            attempt: 0,
            next_at: Utc::now(),
            created_at: Utc::now(),
        }
    }
    fn retry(&mut self) -> bool {
        let (limit, delay) = if self.key.kind == Kind::Sync {
            (6, 15)
        } else {
            (5, 30)
        };
        if self.attempt >= limit {
            return false;
        }
        self.next_at = Utc::now() + Duration::seconds(delay * (1i64 << self.attempt));
        self.attempt += 1;
        true
    }
}

struct SyncResult {
    changed: Vec<Uuid>,
    complete: bool,
    analyze: bool,
}

fn finished(jobs: &mut HashMap<Key, Job>, key: Key, result: Result<Option<SyncResult>>) {
    if let Some(mut job) = jobs.remove(&key) {
        match result {
            Ok(Some(sync)) => {
                if sync.analyze {
                    for id in sync.changed {
                        for kind in [Kind::Classify, Kind::Embed] {
                            let job = Job::new(kind, id);
                            jobs.entry(job.key).or_insert(job);
                        }
                    }
                }
                if !sync.complete {
                    job.attempt = 0;
                    job.created_at = Utc::now();
                    job.next_at = Utc::now() + Duration::seconds(5);
                    jobs.insert(key, job);
                }
            }
            Ok(None) => {}
            Err(error) => {
                eprintln!("Job {key:?} failed: {error}");
                if job.retry() {
                    jobs.insert(key, job);
                }
            }
        }
    }
}
async fn execute(services: &Services, key: Key) -> Result<Option<SyncResult>> {
    match key.kind {
        Kind::Sync => {
            let (_, before) = services.repository.get_sync_cursor(key.id).await?;
            let changed = services.sync_account(key.id).await?;
            let (_, complete) = services.repository.get_sync_cursor(key.id).await?;
            Ok(Some(SyncResult {
                changed,
                complete,
                analyze: before && services.config.openai_api_key.is_some(),
            }))
        }
        Kind::Classify => {
            services.classify_message(key.id).await?;
            Ok(None)
        }
        Kind::Embed => {
            services.embed_message(key.id).await?;
            Ok(None)
        }
    }
}

async fn checkpoint(services: &Services, jobs: &HashMap<Key, Job>) -> Result<()> {
    services.repository.heartbeat("main",json!({"pid":std::process::id(),"schedulerVersion":1,"jobs":jobs.values().collect::<Vec<_>>()})).await
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn worker_lock(path: &std::path::Path) -> Result<std::fs::File> {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(format!(
            "{}.worker.lock",
            std::fs::canonicalize(path)?.display()
        ))?;
    lock.try_lock_exclusive()
        .context("A Rust worker is already running for this database")?;
    Ok(lock)
}

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_env()?;
    let pool = db::pool(&config.database_path, false).await?;
    db::migrate(&pool, &config.migrations_path).await?;
    let lock = worker_lock(std::path::Path::new(&config.database_path))?;
    let services = Arc::new(Services::new(config, Repository(pool.clone())));
    let metadata: Option<serde_json::Value> =
        sqlx::query_scalar("select metadata from worker_state where name='main'")
            .fetch_optional(&pool)
            .await?;
    let restored: Vec<Job> = metadata
        .and_then(|v| v.get("jobs").cloned())
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let mut jobs: HashMap<Key, Job> = restored.into_iter().map(|j| (j.key, j)).collect();
    let mut active = HashSet::<Key>::new();
    let mut tasks = JoinSet::<(Key, Result<Option<SyncResult>>)>::new();
    let mut outbox = JoinSet::<Result<usize>>::new();
    let mut poll = interval(StdDuration::from_secs(25));
    let mut drain = interval(StdDuration::from_secs(10));
    let mut beat = interval(StdDuration::from_secs(30));
    let mut clock = interval(StdDuration::from_millis(200));
    for timer in [&mut poll, &mut drain, &mut beat, &mut clock] {
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    }
    checkpoint(&services, &jobs).await?;
    println!(
        "Sent Rust worker started (fake providers: {})",
        services.config.fake_providers
    );
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    let mut dirty = false;
    loop {
        tokio::select! {
            _=&mut shutdown=>break,
            _=poll.tick()=>{
                match services.repository.list_stored_accounts().await {
                    Ok(accounts)=>for account in accounts {let job=Job::new(Kind::Sync,account.id);if let std::collections::hash_map::Entry::Vacant(entry)=jobs.entry(job.key){entry.insert(job);dirty=true;}},
                    Err(error)=>eprintln!("Account poll failed: {error}"),
                }
            }
            _=beat.tick()=>{if let Err(error)=checkpoint(&services,&jobs).await {eprintln!("Heartbeat failed: {error}");}}
            _=drain.tick()=>{if outbox.is_empty(){let service=services.clone();outbox.spawn(async move{service.process_outbox().await});}}
            Some(result)=outbox.join_next(),if !outbox.is_empty()=>{match result {Ok(Ok(count))=>{if count>0 {println!("Processed {count} outbox mutations");}},Ok(Err(error))=>eprintln!("Outbox failed: {error}"),Err(error)=>eprintln!("Outbox task failed: {error}")}}
            Some(result)=tasks.join_next(),if !tasks.is_empty()=>{
                let (key,result)=result?;active.remove(&key);dirty=true;
                finished(&mut jobs,key,result);
            }
            _=clock.tick()=>{}
        }
        if dirty && let Err(error) = checkpoint(&services, &jobs).await {
            eprintln!("Scheduler checkpoint failed: {error}");
            continue;
        }
        dirty = false;
        let mut counts = HashMap::<Kind, usize>::new();
        for key in &active {
            *counts.entry(key.kind).or_default() += 1;
        }
        for job in jobs.values() {
            let key = job.key;
            let count = counts.entry(key.kind).or_default();
            let limit = if key.kind == Kind::Sync { 2 } else { 3 };
            if job.next_at > Utc::now() || active.contains(&key) || *count >= limit {
                continue;
            }
            if key.kind != Kind::Sync && services.config.openai_api_key.is_none() {
                continue;
            }
            let service = services.clone();
            active.insert(key);
            *count += 1;
            tasks.spawn(async move {
                let result = if key.kind == Kind::Sync {
                    match tokio::time::timeout(
                        StdDuration::from_secs(30 * 60),
                        execute(&service, key),
                    )
                    .await
                    {
                        Ok(result) => result,
                        Err(_) => Err(anyhow::anyhow!("Account sync expired after 30 minutes")),
                    }
                } else {
                    execute(&service, key).await
                };
                (key, result)
            });
        }
    }
    println!("Worker shutting down; draining active jobs");
    let drained = tokio::time::timeout(StdDuration::from_secs(30), async {
        while let Some(result) = tasks.join_next().await {
            if let Ok((key, result)) = result {
                finished(&mut jobs, key, result);
            }
        }
        while outbox.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tasks.abort_all();
        outbox.abort_all();
        while tasks.join_next().await.is_some() {}
        while outbox.join_next().await.is_some() {}
    }
    checkpoint(&services, &jobs).await?;
    drop(lock);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_lock_is_exclusive_and_released_on_drop() -> Result<()> {
        let database = tempfile::NamedTempFile::new()?;
        let lock = worker_lock(database.path())?;
        assert!(worker_lock(database.path()).is_err());
        drop(lock);
        drop(worker_lock(database.path())?);
        std::fs::remove_file(format!("{}.worker.lock", database.path().display()))?;
        assert!(worker_lock(&database.path().join("missing")).is_err());
        Ok(())
    }
    #[test]
    fn retries_are_exponential_and_bounded() {
        for (kind, count, delay) in [
            (Kind::Sync, 6, 15),
            (Kind::Classify, 5, 30),
            (Kind::Embed, 5, 30),
        ] {
            let mut job = Job::new(kind, Uuid::nil());
            for attempt in 0..count {
                let before = Utc::now();
                assert!(job.retry());
                assert!((job.next_at - before).num_seconds() >= (delay * (1 << attempt)) - 1);
            }
            assert!(!job.retry());
        }
    }

    #[test]
    fn backfill_gating_singletons_and_durable_job_roundtrip() {
        let id = Uuid::new_v4();
        let message = Uuid::new_v4();
        let job = Job::new(Kind::Sync, id);
        let key = job.key;
        let mut jobs = HashMap::from([(key, job.clone())]);
        finished(
            &mut jobs,
            key,
            Ok(Some(SyncResult {
                changed: vec![message],
                complete: false,
                analyze: false,
            })),
        );
        assert_eq!(jobs.len(), 1);
        assert!(jobs[&key].next_at > Utc::now());
        finished(
            &mut jobs,
            key,
            Ok(Some(SyncResult {
                changed: vec![message],
                complete: true,
                analyze: false,
            })),
        );
        assert!(jobs.is_empty());
        jobs.insert(key, job.clone());
        finished(
            &mut jobs,
            key,
            Ok(Some(SyncResult {
                changed: vec![message, message],
                complete: true,
                analyze: true,
            })),
        );
        assert_eq!(jobs.len(), 2);
        assert!(jobs.contains_key(&Key {
            kind: Kind::Classify,
            id: message
        }));
        assert!(jobs.contains_key(&Key {
            kind: Kind::Embed,
            id: message
        }));
        let saved = serde_json::to_value(jobs.values().collect::<Vec<_>>()).unwrap();
        for job in saved.as_array().unwrap() {
            assert!(
                job["created_at"]
                    .as_str()
                    .unwrap()
                    .parse::<DateTime<Utc>>()
                    .is_ok()
            );
        }
        let restored: Vec<Job> = serde_json::from_value(saved).unwrap();
        assert_eq!(restored.len(), 2);
        for job in restored {
            finished(&mut jobs, job.key, Ok(None));
        }
        assert!(jobs.is_empty());
        jobs.insert(key, job);
        finished(&mut jobs, key, Err(anyhow::anyhow!("retry")));
        assert_eq!(jobs[&key].attempt, 1);
    }
}
