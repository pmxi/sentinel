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
use sent_core::{live::CHANNEL, repository::ReplicaInventory};
use serde_json::{Value, json};
use sqlx::postgres::PgListener;
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

pub fn start(state: Arc<State>) {
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
            let result = async {
                let mut listener = PgListener::connect_with(&state.repository.0).await?;
                listener.listen(CHANNEL).await?;
                listener.eager_reconnect(false);
                state.clear_inventory_cache().await;
                state.live.availability(true);
                state.live.changed.notify_one();
                backoff = 1;
                loop {
                    match listener.try_recv().await? {
                        Some(notification) => {
                            if let Ok(value) = serde_json::from_str::<Value>(notification.payload())
                                && let (Some(key), Some(expires)) =
                                    (value["logout"].as_str(), value["expires"].as_i64())
                            {
                                state.live.revoke(key.to_owned(), expires);
                            } else {
                                state.live.changed.notify_one();
                            }
                        }
                        None => {
                            state.live.availability(false);
                            return Ok::<_, sqlx::Error>(());
                        }
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
    let Some(session) = auth::cookie(&headers)
        .and_then(|token| auth::session_info(token, state.secret()))
        .filter(|session| state.live.valid(session))
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
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
async fn serve(mut socket: WebSocket, state: Arc<State>, session: auth::Session) {
    let mut updates = state.live.updates.subscribe();
    let mut cursor: Option<String> = None;
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
        if !state.live.valid(&session) {
            close(&mut socket, 4401, "Session ended").await;
            return;
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
                                cursor = value["cursor"].as_str().filter(|cursor| cursor.len() <= 512).map(str::to_owned);
                                if cursor.is_some() { state.live.changed.notify_one(); }
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
                        let hint = json!({"type":"changed","cursor":target}).to_string();
                        let value = cursor.as_deref().and_then(|from| state.sync_feed.lock().unwrap().live_delta(from, &target, &inventory).ok())
                            .unwrap_or(hint);
                        drop(inventory);
                        if !send_text(&mut socket, value).await { return; }
                        if cursor.is_some() { cursor = Some(target); }
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
}
