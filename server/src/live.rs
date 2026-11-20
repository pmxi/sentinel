use crate::{app::State, auth};
use axum::{
    extract::{
        State as ExtractState, WebSocketUpgrade,
        ws::{CloseFrame, Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::Utc;
use sent_core::repository::ReplicaInventory;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, watch};

#[derive(Clone)]
enum Update {
    Idle,
    Changed {
        cursor: String,
        inventory: Arc<ReplicaInventory>,
    },
    Revoked,
    Unavailable,
}

pub struct Hub {
    updates: watch::Sender<Update>,
    changed: Notify,
    available: AtomicBool,
    revoked: Mutex<HashMap<String, i64>>,
    connections: Arc<Mutex<HashMap<String, usize>>>,
}
impl Default for Hub {
    fn default() -> Self {
        Self {
            updates: watch::channel(Update::Idle).0,
            changed: Notify::new(),
            available: AtomicBool::new(false),
            revoked: Mutex::new(HashMap::new()),
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
impl Hub {
    pub(crate) fn valid(&self, session: &auth::Session) -> bool {
        session.expires > Utc::now().timestamp()
            && !self.revoked.lock().unwrap().contains_key(&session.key)
    }
    pub(crate) fn revoke(&self, key: String, expires: i64) {
        let mut revoked = self.revoked.lock().unwrap();
        revoked.retain(|_, expires| *expires > Utc::now().timestamp());
        revoked.insert(key, expires);
        self.updates.send_replace(Update::Revoked);
        self.changed.notify_one();
    }
    fn lease(&self, key: &str) -> Option<SocketLease> {
        let mut connections = self.connections.lock().unwrap();
        if connections.get(key).copied().unwrap_or(0) >= 8
            || connections.values().sum::<usize>() >= 128
        {
            return None;
        }
        *connections.entry(key.to_owned()).or_default() += 1;
        Some(SocketLease {
            key: key.to_owned(),
            connections: self.connections.clone(),
        })
    }
    fn availability(&self, available: bool) {
        self.available.store(available, Ordering::Release);
        if !available {
            self.updates.send_replace(Update::Unavailable);
        }
    }
}

struct SocketLease {
    key: String,
    connections: Arc<Mutex<HashMap<String, usize>>>,
}
impl Drop for SocketLease {
    fn drop(&mut self) {
        let mut connections = self.connections.lock().unwrap();
        if let Some(count) = connections.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                connections.remove(&self.key);
            }
        }
    }
}

async fn coalesce(changed: &Notify) {
    changed.notified().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = tokio::time::timeout(Duration::ZERO, changed.notified()).await;
}

pub async fn start(state: Arc<State>) -> Result<(), sqlx::Error> {
    let revocations: Vec<(String, i64)> = sqlx::query_as(
        "select session,expires from sent_live_revocations where expires>strftime('%s','now')",
    )
    .fetch_all(&state.repository.0)
    .await?;
    for (key, expires) in revocations {
        state.live.revoke(key, expires);
    }
    let publisher = state.clone();
    tokio::spawn(async move {
        loop {
            coalesce(&publisher.live.changed).await;
            if !publisher.live.available.load(Ordering::Acquire)
                || publisher.live.updates.receiver_count() == 0
            {
                continue;
            }
            match publisher.inventory(None, false).await {
                Ok((inventory, _snapshot_guard)) => {
                    let cursor = publisher.sync_feed.lock().unwrap().publish(&inventory);
                    if publisher.live.available.load(Ordering::Acquire)
                        && publisher.live.updates.receiver_count() > 0
                    {
                        publisher.live.updates.send_replace(Update::Changed {
                            cursor,
                            inventory: Arc::new(inventory),
                        });
                    }
                }
                Err(error) => {
                    eprintln!("Live inventory failed: {error}");
                    publisher.live.updates.send_replace(Update::Unavailable);
                }
            }
        }
    });
    tokio::spawn(async move {
        let mut backoff = 1;
        loop {
            let result: Result<(),sqlx::Error> = async {
                let mut listener = state.repository.0.acquire().await?;
                let mut version: i64 = sqlx::query_scalar("pragma data_version").fetch_one(&mut *listener).await?;
                state.clear_inventory_cache().await;
                state.live.availability(true);
                state.live.changed.notify_one();
                backoff = 1;
                let mut ticks = tokio::time::interval(Duration::from_millis(150));
                loop {
                    ticks.tick().await;
                    let current: i64 = sqlx::query_scalar("pragma data_version").fetch_one(&mut *listener).await?;
                    let revocations: Vec<(String,i64)> = sqlx::query_as("select session,expires from sent_live_revocations where expires>strftime('%s','now')").fetch_all(&mut *listener).await?;
                    for (key, expires) in revocations {
                        let known = state.live.revoked.lock().unwrap().contains_key(&key);
                        if !known {
                            state.live.revoke(key, expires);
                        }
                    }
                    if current != version {
                        version = current;
                        state.live.changed.notify_one();
                    }
                }
            }
            .await;
            state.live.availability(false);
            if let Err(error) = result {
                eprintln!("Live listener disconnected: {error}");
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
    Ok(())
}

fn origin_allowed(headers: &HeaderMap, public_url: &str) -> bool {
    if headers.get_all(header::ORIGIN).iter().count() != 1 {
        return false;
    }
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| reqwest::Url::parse(value).ok())
    else {
        return false;
    };
    let Ok(expected) = reqwest::Url::parse(public_url) else {
        return false;
    };
    matches!(origin.scheme(), "http" | "https")
        && origin.origin() == expected.origin()
        && origin.username().is_empty()
        && origin.password().is_none()
        && origin.path() == "/"
        && origin.query().is_none()
        && origin.fragment().is_none()
}

pub async fn upgrade(
    ExtractState(state): ExtractState<Arc<State>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(session) =
        auth::cookie(&headers).and_then(|token| auth::session_info(token, state.secret()))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    match state.session_valid(&session).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
    if !origin_allowed(&headers, &state.config.public_url) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !state.live.available.load(Ordering::Acquire) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Some(lease) = state.live.lease(&session.key) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    ws.write_buffer_size(16 * 1024)
        .max_write_buffer_size(128 * 1024)
        .max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| async move {
            let _lease = lease;
            serve(socket, state, session).await;
        })
        .into_response()
}

async fn send(socket: &mut WebSocket, value: Value) -> bool {
    send_text(socket, value.to_string()).await
}
async fn send_update(socket: &mut WebSocket, value: String, revision: u64) -> bool {
    let Ok(mut value) = serde_json::from_str::<Value>(&value) else {
        return false;
    };
    if value["type"] == "delta" {
        value["revision"] = revision.into();
    }
    send(socket, value).await
}
async fn send_text(socket: &mut WebSocket, value: String) -> bool {
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}
fn update_frame(
    feed: &mut crate::sync::Feed,
    cursor: Option<&str>,
    target: &str,
    inventory: &ReplicaInventory,
    subscription: bool,
) -> Option<String> {
    if cursor == Some(target) {
        return None;
    }
    cursor
        .and_then(|from| feed.live_delta(from, target, inventory).ok())
        .or_else(|| (!subscription).then(|| json!({"type":"changed","cursor":target}).to_string()))
}
async fn serve(mut socket: WebSocket, state: Arc<State>, session: auth::Session) {
    let mut updates = state.live.updates.subscribe();
    let mut cursor: Option<String> = None;
    let mut revision = 0;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut seen = tokio::time::Instant::now();
    let mut frame_window = seen;
    let mut frame_count = 0;
    let expiry = tokio::time::sleep(Duration::from_secs(
        (session.expires - Utc::now().timestamp()).max(0) as u64,
    ));
    tokio::pin!(expiry);
    if !send(&mut socket, json!({"type":"ready"})).await {
        return;
    }
    loop {
        match state.session_valid(&session).await {
            Ok(true) => {}
            Ok(false) => {
                close(&mut socket, 4401, "Session ended").await;
                return;
            }
            Err(_) => {
                close(&mut socket, 1013, "Authentication unavailable").await;
                return;
            }
        }
        if !state.live.available.load(Ordering::Acquire) {
            close(&mut socket, 1013, "Listener unavailable").await;
            return;
        }
        tokio::select! {
            _ = &mut expiry => { close(&mut socket, 4401, "Session expired").await; return; }
            _ = heartbeat.tick() => {
                if seen.elapsed() > Duration::from_secs(45) { close(&mut socket, 1001, "Heartbeat timeout").await; return; }
                if !send(&mut socket, json!({"type":"ping"})).await { return; }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        seen = tokio::time::Instant::now();
                        if frame_window.elapsed() >= Duration::from_secs(1) {
                            frame_window = seen;
                            frame_count = 0;
                        }
                        frame_count += 1;
                        if frame_count > 32 { close(&mut socket, 1008, "Message rate exceeded").await; return; }
                        let Ok(value) = serde_json::from_str::<Value>(&text) else { close(&mut socket, 1008, "Invalid message").await; return; };
                        match value["type"].as_str() {
                            Some("subscribe") => {
                                revision = value["revision"].as_u64().unwrap_or(0);
                                cursor = value["cursor"].as_str().filter(|cursor| cursor.len() <= 512).map(str::to_owned);
                                let update = updates.borrow().clone();
                                if let Update::Changed { cursor: target, inventory } = update {
                                    let value = update_frame(&mut state.sync_feed.lock().unwrap(), cursor.as_deref(), &target, &inventory, true);
                                    if let Some(value) = value
                                        && !send_update(&mut socket, value, revision).await { return; }
                                }
                            }
                            Some("pong") => {}
                            _ => { close(&mut socket, 1008, "Invalid message").await; return; }
                        }
                    }
                    Some(Ok(Message::Pong(_))) => { seen = tokio::time::Instant::now(); }
                    Some(Ok(Message::Ping(_))) => {}
                    _ => return,
                }
            }
            result = updates.changed() => {
                if result.is_err() { return; }
                let update = updates.borrow_and_update().clone();
                if !state.live.valid(&session) { close(&mut socket, 4401, "Session ended").await; return; }
                match update {
                    Update::Unavailable => { close(&mut socket, 1013, "Listener unavailable").await; return; }
                    Update::Changed { cursor: target, inventory } => {
                        let value = update_frame(&mut state.sync_feed.lock().unwrap(), cursor.as_deref(), &target, &inventory, false);
                        drop(inventory);
                        if let Some(value) = value
                            && !send_update(&mut socket, value, revision).await { return; }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreign_cursor_subscriptions_stay_quiet_but_real_changes_still_hint() {
        let empty = ReplicaInventory {
            messages: vec![],
            accounts: vec![],
        };
        let mut feed = crate::sync::Feed::default();
        let target = feed.publish(&empty);
        let foreign = crate::sync::Feed::default().publish(&empty);
        for from in [
            None,
            Some(foreign.as_str()),
            Some("invalid"),
            Some(target.as_str()),
        ] {
            for _ in 0..10 {
                assert!(update_frame(&mut feed, from, &target, &empty, true).is_none());
            }
        }
        let hint: Value = serde_json::from_str(
            &update_frame(&mut feed, Some(&foreign), &target, &empty, false).unwrap(),
        )
        .unwrap();
        assert_eq!(hint, json!({"type":"changed","cursor":target}));
        let changed = ReplicaInventory {
            messages: vec![json!({"id":"one","subject":"New mail"})],
            accounts: vec![],
        };
        let next = feed.publish(&changed);
        let delta: Value = serde_json::from_str(
            &update_frame(&mut feed, Some(&target), &next, &changed, true).unwrap(),
        )
        .unwrap();
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["delta"]["upserts"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn origin_is_required_and_bound_to_the_configured_public_origin() {
        let mut headers = HeaderMap::new();
        assert!(!origin_allowed(&headers, "https://mail.example.test/path"));
        for origin in [
            "null",
            "http://mail.example.test",
            "https://mail.example.test:444",
            "https://evil.test",
            "https://mail.example.test/path",
            "https://user@mail.example.test",
        ] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(
                !origin_allowed(&headers, "https://mail.example.test"),
                "{origin}"
            );
        }
        headers.insert(header::ORIGIN, "https://mail.example.test".parse().unwrap());
        assert!(origin_allowed(&headers, "https://mail.example.test/path"));
        headers.append(header::ORIGIN, "https://mail.example.test".parse().unwrap());
        assert!(!origin_allowed(&headers, "https://mail.example.test"));
    }
    #[test]
    fn socket_limits_are_per_session_and_global_and_release_on_drop() {
        let hub = Hub::default();
        let leases: Vec<_> = (0..8).map(|_| hub.lease("one").unwrap()).collect();
        assert!(hub.lease("one").is_none());
        let other: Vec<_> = (0..120)
            .map(|index| hub.lease(&format!("other-{index}")).unwrap())
            .collect();
        assert!(hub.lease("new").is_none());
        drop(leases);
        assert!(hub.lease("one").is_some());
        drop(other);
        assert!(hub.connections.lock().unwrap().is_empty());
    }
    #[test]
    fn revocation_is_session_scoped_and_expiry_is_enforced() {
        let hub = Hub::default();
        let one = auth::Session {
            key: "one".into(),
            expires: Utc::now().timestamp() + 60,
        };
        let two = auth::Session {
            key: "two".into(),
            expires: one.expires,
        };
        assert!(hub.valid(&one));
        hub.revoke(one.key.clone(), one.expires);
        assert!(!hub.valid(&one));
        assert!(hub.valid(&two));
        assert!(!hub.valid(&auth::Session {
            key: "expired".into(),
            expires: Utc::now().timestamp() - 1
        }));
    }
    #[tokio::test]
    async fn bursts_coalesce_without_losing_the_next_wakeup() {
        let changed = Notify::new();
        for _ in 0..100 {
            changed.notify_one();
        }
        coalesce(&changed).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), changed.notified())
                .await
                .is_err()
        );
        changed.notify_one();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), coalesce(&changed))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn sqlite_poller_fans_out_commits_from_an_independent_worker_pool() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("live.sqlite");
        let pool = sent_core::db::pool(path.to_str().unwrap(), true)
            .await
            .unwrap();
        sent_core::db::migrate(
            &pool,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
        )
        .await
        .unwrap();
        let state = Arc::new(State::new(
            sent_core::config::Config::from_env().unwrap(),
            sent_core::repository::Repository(pool),
        ));
        let logged_out = auth::Session {
            key: "persisted-logout-before-restart".into(),
            expires: Utc::now().timestamp() + 60,
        };
        sent_core::live::notify_logout(&state.repository.0, &logged_out.key, logged_out.expires)
            .await
            .unwrap();
        start(state.clone()).await.unwrap();
        assert!(!state.live.valid(&logged_out));
        let mut updates = state.live.updates.subscribe();
        tokio::time::timeout(Duration::from_secs(3), updates.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(&*updates.borrow_and_update(), Update::Changed { inventory, .. } if inventory.accounts.is_empty())
        );
        let worker = sent_core::repository::Repository(
            sent_core::db::pool(path.to_str().unwrap(), true)
                .await
                .unwrap(),
        );
        worker
            .upsert_account("gmail", "fixture@example.test", "Fixture", "test")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), updates.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(&*updates.borrow_and_update(), Update::Changed { inventory, .. } if inventory.accounts.len() == 1)
        );
        let mut tx = worker.0.begin().await.unwrap();
        sent_core::live::notify_changed(&mut *tx).await.unwrap();
        tx.rollback().await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(350), updates.changed())
                .await
                .is_err()
        );
        let session = auth::Session {
            key: "opaque-fixture-session".into(),
            expires: Utc::now().timestamp() + 60,
        };
        sent_core::live::notify_logout(&worker.0, &session.key, session.expires)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.live.valid(&session) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn startup_fails_when_revocations_cannot_be_loaded() {
        let directory = tempfile::tempdir().unwrap();
        let pool = sent_core::db::pool(
            directory.path().join("unmigrated.sqlite").to_str().unwrap(),
            true,
        )
        .await
        .unwrap();
        let state = Arc::new(State::new(
            sent_core::config::Config::from_env().unwrap(),
            sent_core::repository::Repository(pool),
        ));
        assert!(start(state.clone()).await.is_err());
        assert!(!state.live.available.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn direct_sql_commits_publish_fresh_inventory_without_notifications() {
        async fn next(updates: &mut watch::Receiver<Update>) -> (String, Arc<ReplicaInventory>) {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    updates.changed().await.unwrap();
                    if let Update::Changed { cursor, inventory } =
                        updates.borrow_and_update().clone()
                    {
                        return (cursor, inventory);
                    }
                }
            })
            .await
            .unwrap()
        }
        const FIXTURE: &str = "insert into accounts(id,provider,email,encrypted_credentials) values('00000000-0000-4000-8000-000000000001','gmail','fixture@example.test','test');
            insert into threads(id,account_id,provider_thread_id,last_message_at) values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','thread','2026-01-01T00:00:00.000000Z');
            insert into messages(id,account_id,thread_id,provider_message_id,received_at,direction,text_body) values('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','message','2026-01-01T00:00:00.000000Z','inbound','Original');";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("direct.sqlite");
        let pool = sent_core::db::pool(path.to_str().unwrap(), true)
            .await
            .unwrap();
        sent_core::db::migrate(
            &pool,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
        )
        .await
        .unwrap();
        let state = Arc::new(State::new(
            sent_core::config::Config::from_env().unwrap(),
            sent_core::repository::Repository(pool),
        ));
        start(state.clone()).await.unwrap();
        let mut updates = state.live.updates.subscribe();
        assert!(next(&mut updates).await.1.messages.is_empty());
        let writer = sent_core::db::pool(path.to_str().unwrap(), true)
            .await
            .unwrap();
        let signal: i64 = sqlx::query_scalar("select revision from sent_live_signal")
            .fetch_one(&writer)
            .await
            .unwrap();
        let mut tx = writer.begin().await.unwrap();
        sqlx::raw_sql(FIXTURE).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let (_, inserted) = next(&mut updates).await;
        assert_eq!(inserted.messages.len(), 1);
        let original = inserted.messages[0]["bodyVersion"].clone();
        sqlx::query("update messages set text_body='Direct edit',subject='Fresh subject'")
            .execute(&writer)
            .await
            .unwrap();
        let (_, edited) = next(&mut updates).await;
        assert_eq!(edited.messages[0]["subject"], "Fresh subject");
        assert_ne!(edited.messages[0]["bodyVersion"], original);
        sqlx::query("insert into classifications(message_id,model_tier,reasoning,model,prompt_version,plain_text) values('00000000-0000-4000-8000-000000000003',1,'test','test','test','Direct classification')").execute(&writer).await.unwrap();
        let (cursor, classified) = next(&mut updates).await;
        assert_eq!(classified.messages[0]["tier"], 1);
        assert_ne!(
            classified.messages[0]["bodyVersion"],
            edited.messages[0]["bodyVersion"]
        );
        sqlx::query("update threads set subject='Direct thread edit'")
            .execute(&writer)
            .await
            .unwrap();
        let (thread_cursor, thread_edit) = next(&mut updates).await;
        assert_ne!(thread_cursor, cursor);
        assert_eq!(thread_edit.messages, classified.messages);
        sqlx::query("delete from classifications")
            .execute(&writer)
            .await
            .unwrap();
        let (_, unclassified) = next(&mut updates).await;
        assert_eq!(
            unclassified.messages[0]["bodyVersion"],
            edited.messages[0]["bodyVersion"]
        );
        let mut tx = writer.begin().await.unwrap();
        sqlx::query("delete from accounts")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(FIXTURE).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let (_, reseeded) = next(&mut updates).await;
        assert_eq!(reseeded.messages[0]["bodyVersion"], original);
        assert_ne!(
            reseeded.messages[0]["bodyVersion"],
            unclassified.messages[0]["bodyVersion"]
        );
        sqlx::query("delete from threads")
            .execute(&writer)
            .await
            .unwrap();
        assert!(next(&mut updates).await.1.messages.is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("select revision from sent_live_signal")
                .fetch_one(&writer)
                .await
                .unwrap(),
            signal
        );
    }
}
