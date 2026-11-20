use crate::app::State;
use axum::{
    Json,
    extract::{Query, State as ExtractState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sent_core::repository::{ReplicaInventory, replica_fingerprint};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Default)]
pub struct Feed {
    generations: VecDeque<Generation>,
}
struct Generation {
    id: Uuid,
    touched: Instant,
    hashes: Arc<HashMap<String, String>>,
    snapshot: Option<Arc<Vec<Value>>>,
    accounts: Vec<Value>,
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
    fn find(&mut self, id: Uuid) -> Result<&mut Generation, Fault> {
        self.generations
            .retain(|entry| entry.touched.elapsed() < Duration::from_secs(900));
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
    fn insert(&mut self, inventory: ReplicaInventory, snapshot: bool) -> Uuid {
        let id = Uuid::new_v4();
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
        self.generations.push_back(Generation {
            id,
            touched: Instant::now(),
            hashes,
            snapshot: snapshot.then(|| Arc::new(inventory.messages)),
            accounts: inventory.accounts,
        });
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
    fn delta(&mut self, cursor: Cursor, inventory: ReplicaInventory) -> Result<Value, Fault> {
        let before = self.find(cursor.generation)?.hashes.clone();
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
        let id = if upserts.is_empty() && deletions.is_empty() {
            cursor.generation
        } else {
            self.insert(inventory, false)
        };
        Ok(
            json!({"upserts":upserts,"deletions":deletions,"accounts":accounts,"cursor":encode(id,None)}),
        )
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
            let inventory = match state.repository.replica_inventory(None, false).await {
                Ok(value) => value,
                Err(error) => return internal(error),
            };
            let id = state.sync_feed.lock().unwrap().insert(inventory, true);
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
    let inventory = match state.repository.replica_inventory(None, false).await {
        Ok(value) => value,
        Err(error) => return internal(error),
    };
    match state.sync_feed.lock().unwrap().delta(cursor, inventory) {
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
    match state.repository.replica_inventory(Some(&ids), true).await {
        Ok(inventory) => {
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
}
