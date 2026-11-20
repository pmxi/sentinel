use crate::app::State;
use axum::{
    Json,
    extract::{Query, State as ExtractState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sent_core::db::Uuid;
use sent_core::repository::ReplicaInventory;
#[cfg(test)]
use sent_core::repository::replica_fingerprint;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Feed {
    generations: VecDeque<Generation>,
    sequence: u64,
    rows: BTreeMap<String, Value>,
    current: Option<Uuid>,
}
#[derive(Default)]
struct Patch {
    upserts: Vec<Value>,
    deletions: Vec<String>,
}
struct Generation {
    id: Uuid,
    sequence: u64,
    touched: Instant,
    hashes: Arc<HashMap<String, String>>,
    snapshot: Option<Arc<Vec<Value>>>,
    accounts: Vec<Value>,
    patch: Option<Patch>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    generation: Uuid,
    offset: Option<usize>,
}
#[derive(Deserialize)]
pub struct Input {
    cursor: Option<String>,
    limit: Option<usize>,
    ids: Option<String>,
}
enum Fault {
    Invalid,
    Expired,
}
impl IntoResponse for Fault {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid sync request"})),
            )
                .into_response(),
            Self::Expired => (
                StatusCode::GONE,
                Json(json!({"error":"Replica cursor expired","reset":true})),
            )
                .into_response(),
        }
    }
}
fn encode(generation: Uuid, offset: Option<usize>) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&Cursor {
            version: 1,
            generation,
            offset,
        })
        .expect("cursor"),
    )
}
fn decode(cursor: &str, paged: bool) -> Result<Cursor, Fault> {
    if cursor.len() > 512 {
        return Err(Fault::Invalid);
    }
    let value: Cursor =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor).map_err(|_| Fault::Invalid)?)
            .map_err(|_| Fault::Invalid)?;
    if value.version != 1 || value.offset.is_some() != paged {
        return Err(Fault::Invalid);
    }
    Ok(value)
}
impl Feed {
    pub(crate) fn apply(&mut self, update: sent_core::repository::ReplicaUpdate) -> String {
        let mut patch = Patch::default();
        if update.full {
            let next: BTreeMap<_, _> = update
                .inventory
                .messages
                .into_iter()
                .map(|row| (row["id"].as_str().expect("id").to_owned(), row))
                .collect();
            patch.deletions = self
                .rows
                .keys()
                .filter(|id| !next.contains_key(*id))
                .cloned()
                .collect();
            patch.upserts = next.values().cloned().collect();
            self.rows = next;
        } else {
            for id in update.ids {
                let id = id.to_string();
                if self.rows.remove(&id).is_some() {
                    patch.deletions.push(id);
                }
            }
            for row in update.inventory.messages {
                let id = row["id"].as_str().expect("id").to_owned();
                self.rows.insert(id, row.clone());
                patch.upserts.push(row);
            }
            let inserted: std::collections::HashSet<_> = patch
                .upserts
                .iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect();
            patch.deletions.retain(|id| !inserted.contains(id.as_str()));
        }
        if self.current.is_none() {
            patch = Patch::default();
        }
        let id = self.record(
            Arc::new(HashMap::new()),
            update.inventory.accounts,
            None,
            false,
        );
        self.generations.back_mut().expect("generation").patch = Some(patch);
        self.current = Some(id);
        while self
            .generations
            .iter()
            .map(|g| {
                g.patch
                    .as_ref()
                    .map_or(0, |p| p.upserts.len() + p.deletions.len())
            })
            .sum::<usize>()
            > 65_536
            && self.generations.len() > 1
        {
            self.generations.pop_front();
        }
        encode(id, None)
    }
    pub(crate) fn current_cursor(&self) -> Option<String> {
        self.current.map(|id| encode(id, None))
    }
    pub(crate) fn published_inventory(&self) -> ReplicaInventory {
        let current = self
            .generations
            .iter()
            .find(|g| Some(g.id) == self.current)
            .expect("initialized");
        ReplicaInventory {
            messages: current
                .patch
                .as_ref()
                .map_or_else(Vec::new, |p| p.upserts.clone()),
            accounts: current.accounts.clone(),
        }
    }
    fn cached_snapshot(&mut self) -> Result<Uuid, Fault> {
        let id = self.current.ok_or(Fault::Expired)?;
        if self.find(id)?.snapshot.is_none() {
            let rows = Arc::new(self.rows.values().cloned().collect());
            self.find(id)?.snapshot = Some(rows);
        }
        Ok(id)
    }
    fn cached_delta(&mut self, from: Uuid, to: Uuid, bounded: bool) -> Result<Value, Fault> {
        let first = self.find(from)?.sequence;
        let target = self.find(to)?;
        let last = target.sequence;
        let accounts = target.accounts.clone();
        if last < first {
            return Err(Fault::Expired);
        }
        let mut generations: Vec<_> = self
            .generations
            .iter()
            .filter(|g| g.sequence > first && g.sequence <= last)
            .collect();
        generations.sort_by_key(|g| g.sequence);
        let mut changes: BTreeMap<&str, Option<&Value>> = BTreeMap::new();
        let mut expected = first + 1;
        for generation in generations {
            if generation.sequence != expected {
                return Err(Fault::Expired);
            }
            expected += 1;
            let patch = generation.patch.as_ref().ok_or(Fault::Expired)?;
            for id in &patch.deletions {
                changes.insert(id, None);
            }
            for row in &patch.upserts {
                changes.insert(row["id"].as_str().expect("id"), Some(row));
            }
        }
        if expected != last + 1 {
            return Err(Fault::Expired);
        }
        if bounded
            && (changes.values().filter(|v| v.is_some()).count() > 32
                || changes.values().filter(|v| v.is_none()).count() > 512)
        {
            return Err(Fault::Expired);
        }
        let upserts: Vec<_> = changes.values().filter_map(|v| *v).collect();
        let deletions: Vec<_> = changes
            .iter()
            .filter_map(|(id, v)| v.is_none().then_some(*id))
            .collect();
        Ok(
            json!({"upserts":upserts,"deletions":deletions,"accounts":accounts,"cursor":encode(to,None)}),
        )
    }
    fn find(&mut self, id: Uuid) -> Result<&mut Generation, Fault> {
        self.generations.retain(|entry| {
            Some(entry.id) == self.current || entry.touched.elapsed() < Duration::from_secs(900)
        });
        let index = self
            .generations
            .iter()
            .position(|entry| entry.id == id)
            .ok_or(Fault::Expired)?;
        let mut entry = self.generations.remove(index).expect("generation");
        entry.touched = Instant::now();
        self.generations.push_back(entry);
        Ok(self.generations.back_mut().expect("generation"))
    }
    #[cfg(test)]
    fn insert(&mut self, inventory: ReplicaInventory, snapshot: bool) -> Uuid {
        let hashes = Arc::new(
            inventory
                .messages
                .iter()
                .map(|row| {
                    (
                        row["id"].as_str().expect("message id").to_owned(),
                        replica_fingerprint(row),
                    )
                })
                .collect(),
        );
        self.record(
            hashes,
            inventory.accounts,
            snapshot.then(|| Arc::new(inventory.messages)),
            true,
        )
    }
    fn record(
        &mut self,
        hashes: Arc<HashMap<String, String>>,
        accounts: Vec<Value>,
        snapshot: Option<Arc<Vec<Value>>>,
        reuse: bool,
    ) -> Uuid {
        self.sequence += 1;
        let id = if let Some(index) = self
            .generations
            .iter()
            .position(|entry| reuse && entry.hashes == hashes && entry.accounts == accounts)
        {
            let mut entry = self.generations.remove(index).expect("generation");
            entry.sequence = self.sequence;
            entry.touched = Instant::now();
            if snapshot.is_some() {
                entry.snapshot = snapshot;
            }
            let id = entry.id;
            self.generations.push_back(entry);
            id
        } else {
            let id = Uuid::new_v4();
            self.generations.push_back(Generation {
                id,
                sequence: self.sequence,
                touched: Instant::now(),
                hashes,
                snapshot,
                patch: None,
                accounts,
            });
            id
        };
        while self.generations.len() > 16 {
            self.generations.pop_front();
        }
        let mut snapshots = self
            .generations
            .iter()
            .filter(|entry| entry.snapshot.is_some())
            .count();
        for entry in &mut self.generations {
            if snapshots <= 2 {
                break;
            }
            if entry.snapshot.take().is_some() {
                snapshots -= 1;
            }
        }
        id
    }
    #[cfg(test)]
    pub(crate) fn publish(&mut self, inventory: &ReplicaInventory) -> String {
        let hashes = Arc::new(
            inventory
                .messages
                .iter()
                .map(|row| {
                    (
                        row["id"].as_str().expect("message id").to_owned(),
                        replica_fingerprint(row),
                    )
                })
                .collect(),
        );
        let id = self.record(hashes, inventory.accounts.clone(), None, false);
        encode(id, None)
    }
    pub(crate) fn live_delta(
        &mut self,
        from: &str,
        to: &str,
        inventory: &ReplicaInventory,
    ) -> Result<String, ()> {
        let target = decode(to, false).map_err(|_| ())?.generation;
        if self.find(target).map_err(|_| ())?.patch.is_some() {
            let delta = self
                .cached_delta(
                    decode(from, false).map_err(|_| ())?.generation,
                    target,
                    true,
                )
                .map_err(|_| ())?;
            let mut output = BoundedJson(Vec::new());
            serde_json::to_writer(
                &mut output,
                &json!({"type":"delta","from":from,"delta":delta}),
            )
            .map_err(|_| ())?;
            return String::from_utf8(output.0).map_err(|_| ());
        }
        let before = self
            .find(decode(from, false).map_err(|_| ())?.generation)
            .map_err(|_| ())?;
        let sequence = before.sequence;
        let before = before.hashes.clone();
        let current = self
            .find(decode(to, false).map_err(|_| ())?.generation)
            .map_err(|_| ())?;
        if current.sequence < sequence {
            return Err(());
        }
        let current = current.hashes.clone();
        let upserts: Vec<_> = inventory
            .messages
            .iter()
            .filter(|row| {
                let id = row["id"].as_str().expect("message id");
                before.get(id) != current.get(id)
            })
            .take(33)
            .collect();
        let mut deletions: Vec<_> = before
            .keys()
            .filter(|id| !current.contains_key(*id))
            .take(513)
            .collect();
        if upserts.len() > 32 || deletions.len() > 512 {
            return Err(());
        }
        deletions.sort();
        #[derive(Serialize)]
        struct Delta<'a> {
            upserts: Vec<&'a Value>,
            deletions: Vec<&'a String>,
            accounts: &'a Vec<Value>,
            cursor: &'a str,
        }
        #[derive(Serialize)]
        struct Push<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            from: &'a str,
            delta: Delta<'a>,
        }
        let value = Push {
            kind: "delta",
            from,
            delta: Delta {
                upserts,
                deletions,
                accounts: &inventory.accounts,
                cursor: to,
            },
        };
        let mut output = BoundedJson(Vec::new());
        serde_json::to_writer(&mut output, &value).map_err(|_| ())?;
        String::from_utf8(output.0).map_err(|_| ())
    }
    fn page(&mut self, cursor: Cursor, limit: usize) -> Result<Value, Fault> {
        let entry = self.find(cursor.generation)?;
        let rows = entry.snapshot.as_ref().ok_or(Fault::Expired)?;
        let offset = cursor.offset.ok_or(Fault::Invalid)?;
        if offset > rows.len() {
            return Err(Fault::Invalid);
        }
        let end = offset.saturating_add(limit).min(rows.len());
        Ok(
            json!({"messages":rows[offset..end],"accounts":entry.accounts,"nextCursor":(end<rows.len()).then(||encode(entry.id,Some(end))),"cursor":encode(entry.id,None)}),
        )
    }
    #[cfg(test)]
    fn delta(&mut self, cursor: Cursor, inventory: ReplicaInventory) -> Result<Value, Fault> {
        let previous = self.find(cursor.generation)?;
        let accounts_changed = previous.accounts != inventory.accounts;
        let before = previous.hashes.clone();
        let current: HashMap<_, _> = inventory
            .messages
            .iter()
            .map(|row| {
                (
                    row["id"].as_str().expect("message id").to_owned(),
                    replica_fingerprint(row),
                )
            })
            .collect();
        let upserts: Vec<_> = inventory
            .messages
            .iter()
            .filter(|row| {
                before.get(row["id"].as_str().unwrap()) != current.get(row["id"].as_str().unwrap())
            })
            .cloned()
            .collect();
        let mut deletions: Vec<_> = before
            .keys()
            .filter(|id| !current.contains_key(*id))
            .cloned()
            .collect();
        deletions.sort();
        let accounts = inventory.accounts.clone();
        let hashes = if upserts.is_empty() && deletions.is_empty() {
            before
        } else {
            Arc::new(current)
        };
        let id = if upserts.is_empty() && deletions.is_empty() && !accounts_changed {
            self.sequence += 1;
            let sequence = self.sequence;
            self.find(cursor.generation)?.sequence = sequence;
            cursor.generation
        } else {
            self.record(hashes, inventory.accounts, None, true)
        };
        Ok(
            json!({"upserts":upserts,"deletions":deletions,"accounts":accounts,"cursor":encode(id,None)}),
        )
    }
}
struct BoundedJson(Vec<u8>);
impl std::io::Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > (64 * 1024_usize).saturating_sub(self.0.len()) {
            return Err(std::io::Error::other("Live delta too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn internal(error: anyhow::Error) -> Response {
    crate::app::ApiError::from(error).into_response()
}
pub async fn snapshot(
    ExtractState(state): ExtractState<Arc<State>>,
    query: Result<Query<Input>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(input)) = query else {
        return Fault::Invalid.into_response();
    };
    let limit = input.limit.unwrap_or(1000);
    if !(1..=2000).contains(&limit) {
        return Fault::Invalid.into_response();
    }
    let cursor = match input.cursor {
        Some(cursor) => match decode(&cursor, true) {
            Ok(cursor) => cursor,
            Err(error) => return error.into_response(),
        },
        None => {
            let _guard = match state.refresh_feed().await {
                Ok(value) => value,
                Err(error) => return internal(error),
            };
            let id = match state.sync_feed.lock().unwrap().cached_snapshot() {
                Ok(id) => id,
                Err(error) => return error.into_response(),
            };
            Cursor {
                version: 1,
                generation: id,
                offset: Some(0),
            }
        }
    };
    match state.sync_feed.lock().unwrap().page(cursor, limit) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}
pub async fn delta(
    ExtractState(state): ExtractState<Arc<State>>,
    query: Result<Query<Input>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(Input {
        cursor: Some(cursor),
        ..
    })) = query
    else {
        return Fault::Invalid.into_response();
    };
    let cursor = match decode(&cursor, false) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if let Err(error) = state.sync_feed.lock().unwrap().find(cursor.generation) {
        return error.into_response();
    }
    let _guard = match state.refresh_feed().await {
        Ok(value) => value,
        Err(error) => return internal(error),
    };
    let mut feed = state.sync_feed.lock().unwrap();
    let target = feed.current.expect("initialized feed");
    match feed.cached_delta(cursor.generation, target, false) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}
pub async fn bodies(
    ExtractState(state): ExtractState<Arc<State>>,
    query: Result<Query<Input>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let Ok(Query(Input { ids: Some(ids), .. })) = query else {
        return Fault::Invalid.into_response();
    };
    let Ok(ids) = ids
        .split(',')
        .map(str::parse::<Uuid>)
        .collect::<Result<Vec<_>, _>>()
    else {
        return Fault::Invalid.into_response();
    };
    if ids.is_empty() || ids.len() > 16 {
        return Fault::Invalid.into_response();
    }
    match state.inventory(Some(&ids), true).await {
        Ok((inventory, _snapshot_guard)) => {
            Json(json!({"messages":inventory.messages,"maxBodyBytes":262144})).into_response()
        }
        Err(error) => internal(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inventory(rows: Vec<Value>) -> ReplicaInventory {
        ReplicaInventory {
            messages: rows,
            accounts: vec![],
        }
    }
    fn row(id: &str, value: bool) -> Value {
        json!({"id":id,"read":value})
    }
    #[test]
    fn live_deltas_share_a_cursor_and_match_the_authoritative_feed() {
        let mut feed = Feed::default();
        let first = feed.insert(inventory(vec![row("a", false), row("b", false)]), true);
        let from = encode(first, None);
        let changed = inventory(vec![row("a", true), row("c", false)]);
        let to = feed.publish(&changed);
        let pushed: Value =
            serde_json::from_str(&feed.live_delta(&from, &to, &changed).unwrap()).unwrap();
        assert_eq!(pushed["from"], from);
        assert_eq!(pushed["delta"]["cursor"], to);
        let http = feed
            .delta(
                decode(&from, false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("a", true), row("c", false)]),
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(pushed["delta"]["upserts"], http["upserts"]);
        assert_eq!(pushed["delta"]["deletions"], http["deletions"]);
        let unchanged: Value =
            serde_json::from_str(&feed.live_delta(&to, &to, &changed).unwrap()).unwrap();
        assert_eq!(unchanged["delta"]["upserts"], json!([]));
        assert!(feed.live_delta("invalid", &to, &changed).is_err());
    }
    #[test]
    fn a_stale_live_snapshot_cannot_undo_a_newer_http_sync() {
        let mut feed = Feed::default();
        let old = inventory(vec![]);
        let published = feed.publish(&old);
        let current = inventory(vec![row("new-mail", false)]);
        let http = feed
            .delta(
                decode(&published, false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("new-mail", false)]),
            )
            .unwrap_or_else(|_| panic!());
        let cursor = http["cursor"].as_str().unwrap();
        assert!(
            feed.live_delta(cursor, &published, &old).is_err(),
            "A matching from cursor must not permit deleting newly HTTP-synced mail"
        );
        assert!(feed.live_delta(&published, cursor, &current).is_ok());
    }
    #[test]
    fn idle_tabs_cannot_evict_another_tabs_live_cursor() {
        let mut feed = Feed::default();
        let healthy = feed.insert(inventory(vec![row("mail", false)]), true);
        let mut other = encode(feed.insert(inventory(vec![row("mail", false)]), true), None);
        for _ in 0..40 {
            let before = other.clone();
            let delta = feed
                .delta(
                    decode(&other, false).unwrap_or_else(|_| panic!()),
                    inventory(vec![row("mail", false)]),
                )
                .unwrap_or_else(|_| panic!());
            other = delta["cursor"].as_str().unwrap().to_owned();
            assert_eq!(other, before, "An unchanged poll must retain its cursor");
        }
        for _ in 0..40 {
            feed.insert(inventory(vec![row("mail", false)]), true);
        }
        assert!(feed.find(healthy).is_ok());
        assert_eq!(feed.generations.len(), 1);
    }
    #[test]
    fn an_unchanged_http_observation_also_supersedes_stale_live_frames() {
        let mut feed = Feed::default();
        let first = feed.publish(&inventory(vec![row("new-mail", false)]));
        let stale = feed.publish(&inventory(vec![]));
        let http = feed
            .delta(
                decode(&first, false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("new-mail", false)]),
            )
            .unwrap_or_else(|_| panic!());
        let cursor = http["cursor"].as_str().unwrap();
        assert!(http["upserts"].as_array().unwrap().is_empty());
        assert!(http["deletions"].as_array().unwrap().is_empty());
        assert_eq!(cursor, first);
        assert!(feed.live_delta(cursor, &stale, &inventory(vec![])).is_err());
        let next = feed.publish(&inventory(vec![]));
        assert!(feed.live_delta(cursor, &next, &inventory(vec![])).is_ok());
    }
    #[test]
    fn large_deltas_fall_back_to_hints_before_allocating_unbounded_frames() {
        let mut feed = Feed::default();
        let first = feed.insert(inventory(vec![]), true);
        let from = encode(first, None);
        let many = inventory(
            (0..33)
                .map(|index| row(&index.to_string(), false))
                .collect(),
        );
        let to = feed.publish(&many);
        assert!(feed.live_delta(&from, &to, &many).is_err());
        let huge = inventory(vec![json!({"id":"huge","subject":"x".repeat(65536)})]);
        let to = feed.publish(&huge);
        assert!(feed.live_delta(&from, &to, &huge).is_err());
        let empty = inventory(vec![]);
        let to = feed.publish(&empty);
        assert!(feed.live_delta(&from, &to, &empty).is_ok());
    }
    #[test]
    fn immutable_pages_and_replayable_deltas_cover_upserts_deletions_and_undo() {
        let mut feed = Feed::default();
        let first = feed.insert(inventory(vec![row("a", false), row("b", false)]), true);
        let page = feed
            .page(
                decode(&encode(first, Some(0)), true).unwrap_or_else(|_| panic!()),
                1,
            )
            .unwrap_or_else(|_| panic!());
        let changed = feed
            .delta(
                decode(&encode(first, None), false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("a", true), row("c", false)]),
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(changed["upserts"], json!([row("a", true), row("c", false)]));
        assert_eq!(changed["deletions"], json!(["b"]));
        let second = feed
            .page(
                decode(page["nextCursor"].as_str().unwrap(), true).unwrap_or_else(|_| panic!()),
                1,
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(second["messages"], json!([row("b", false)]));
        let replay = feed
            .delta(
                decode(&encode(first, None), false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("a", true), row("c", false)]),
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(replay["upserts"], changed["upserts"]);
        let undo = feed
            .delta(
                decode(changed["cursor"].as_str().unwrap(), false).unwrap_or_else(|_| panic!()),
                inventory(vec![row("a", false), row("b", false)]),
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(undo["deletions"], json!(["c"]));
        assert_eq!(undo["upserts"], json!([row("a", false), row("b", false)]));
    }
    #[test]
    fn empty_inventory_invalid_and_expired_cursors() {
        let mut feed = Feed::default();
        let id = feed.insert(inventory(vec![]), true);
        let page = feed
            .page(
                decode(&encode(id, Some(0)), true).unwrap_or_else(|_| panic!()),
                1,
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(page["messages"], json!([]));
        assert!(page["nextCursor"].is_null());
        let delta = feed
            .delta(
                decode(page["cursor"].as_str().unwrap(), false).unwrap_or_else(|_| panic!()),
                inventory(vec![]),
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(delta["cursor"], page["cursor"]);
        assert_eq!(delta["upserts"], json!([]));
        assert!(decode("bad", false).is_err());
        assert!(feed.find(Uuid::new_v4()).is_err());
    }

    fn update(
        rows: Vec<Value>,
        ids: Vec<&str>,
        full: bool,
    ) -> sent_core::repository::ReplicaUpdate {
        sent_core::repository::ReplicaUpdate {
            mark: (0, 0),
            full,
            ids: ids.into_iter().map(|s| s.parse().unwrap()).collect(),
            inventory: inventory(rows),
        }
    }
    #[test]
    fn incremental_feed_retains_noop_cursors_and_pages_and_rejects_rollback() {
        let mut feed = Feed::default();
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        let first = feed.apply(update(vec![row(&a, false), row(&b, false)], vec![], true));
        let page = feed.cached_snapshot().unwrap_or_else(|_| panic!());
        let second = feed.apply(update(vec![row(&a, true)], vec![&a], false));
        let delta = feed
            .cached_delta(
                decode(&first, false)
                    .unwrap_or_else(|_| panic!())
                    .generation,
                decode(&second, false)
                    .unwrap_or_else(|_| panic!())
                    .generation,
                false,
            )
            .unwrap_or_else(|_| panic!());
        assert_eq!(delta["upserts"], json!([row(&a, true)]));
        assert_eq!(feed.rows.len(), 2);
        for _ in 0..40 {
            assert_eq!(
                feed.cached_snapshot().unwrap_or_else(|_| panic!()),
                decode(&second, false)
                    .unwrap_or_else(|_| panic!())
                    .generation
            );
            let current = feed.current.unwrap();
            assert_eq!(
                feed.cached_delta(current, current, false)
                    .unwrap_or_else(|_| panic!())["cursor"],
                second
            );
        }
        assert_eq!(feed.generations.len(), 2);
        assert!(
            feed.live_delta(&second, &first, &inventory(vec![]))
                .is_err()
        );
        let oldpage = feed
            .page(
                Cursor {
                    version: 1,
                    generation: page,
                    offset: Some(0),
                },
                2000,
            )
            .unwrap_or_else(|_| panic!());
        assert!(
            oldpage["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["id"] == a && r["read"] == false)
        );
        let third = feed.apply(update(vec![], vec![&b], false));
        let pushed: Value =
            serde_json::from_str(&feed.live_delta(&first, &third, &inventory(vec![])).unwrap())
                .unwrap();
        assert_eq!(pushed["delta"]["deletions"], json!([b]));
        assert_eq!(pushed["delta"]["upserts"], json!([row(&a, true)]));
        let current = feed.current.unwrap();
        feed.find(current).unwrap_or_else(|_| panic!()).touched =
            Instant::now() - Duration::from_secs(1000);
        assert!(feed.cached_snapshot().is_ok());
        assert!(feed.live_delta("bad", &third, &inventory(vec![])).is_err());
    }
    #[test]
    fn incremental_history_gaps_expire_instead_of_silently_losing_rows() {
        let mut feed = Feed::default();
        let a = Uuid::new_v4().to_string();
        let first = feed.apply(update(vec![], vec![], true));
        let second = feed.apply(update(vec![row(&a, false)], vec![&a], false));
        let third = feed.apply(update(vec![row(&a, true)], vec![&a], false));
        feed.generations.retain(|g| {
            g.id != decode(&second, false)
                .unwrap_or_else(|_| panic!())
                .generation
        });
        assert!(feed.live_delta(&first, &third, &inventory(vec![])).is_err());
    }
}
