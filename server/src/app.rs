use crate::{
    auth,
    validation::{
        self, Schema, Validated, ZodJson, ZodQuery, default, nullable, optional, string, uuid,
    },
};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Request, State as ExtractState},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use sent_core::db::Uuid;
use sent_core::{
    config::Config,
    repository::{DraftInput, ListInput, Repository, SearchInput, ThreadActionInput, timestamp},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration as StdDuration, Instant},
};
use tower_http::services::{ServeDir, ServeFile};

pub struct State {
    pub config: Config,
    pub repository: Repository,
    logins: Mutex<HashMap<String, (Instant, u32)>>,
    http: reqwest::Client,
    providers: sent_core::providers::Providers,
    pub(crate) sync_feed: Mutex<crate::sync::Feed>,
    pub(crate) live: crate::live::Hub,
    inventory_cache: tokio::sync::Mutex<sent_core::repository::BodyVersionCache>,
}

impl State {
    pub fn new(config: Config, repository: Repository) -> Self {
        let providers = sent_core::providers::Providers::new(config.clone(), repository.0.clone());
        Self {
            config,
            repository,
            logins: Mutex::new(HashMap::new()),
            http: reqwest::Client::new(),
            providers,
            sync_feed: Mutex::new(crate::sync::Feed::default()),
            live: crate::live::Hub::default(),
            inventory_cache: tokio::sync::Mutex::default(),
        }
    }
    pub(crate) fn secret(&self) -> &str {
        self.config
            .session_secret
            .as_deref()
            .expect("validated session secret")
    }
    pub(crate) async fn session_valid(&self, session: &auth::Session) -> anyhow::Result<bool> {
        if !self.live.valid(session) {
            return Ok(false);
        }
        Ok(!sent_core::live::session_revoked(&self.repository.0, &session.key).await?)
    }
    // Keep the guard until this snapshot has been published to the feed.
    pub(crate) async fn inventory(
        &self,
        ids: Option<&[Uuid]>,
        bodies: bool,
    ) -> anyhow::Result<(
        sent_core::repository::ReplicaInventory,
        tokio::sync::MutexGuard<'_, sent_core::repository::BodyVersionCache>,
    )> {
        let mut cache = self.inventory_cache.lock().await;
        let inventory = self
            .repository
            .replica_inventory_cached(ids, bodies, &mut cache)
            .await?;
        Ok((inventory, cache))
    }
    pub(crate) async fn clear_inventory_cache(&self) {
        self.inventory_cache.lock().await.clear();
    }
    fn cookie(&self, token: Option<&str>) -> String {
        let secure = if self.config.public_url.starts_with("https:") {
            "; Secure"
        } else {
            ""
        };
        match token {
            Some(token) => format!(
                "sent_session={token}; Max-Age=2592000; Path=/; HttpOnly{secure}; SameSite=Lax"
            ),
            None => format!("sent_session=; Max-Age=0; Path=/; HttpOnly{secure}; SameSite=Lax"),
        }
    }
}

type Shared = Arc<State>;
type ApiResult<T> = Result<T, ApiError>;

impl Validated for Login {
    fn schema() -> Schema {
        Schema::Object(vec![("password", string(1, Some(1024)))])
    }
}
impl Validated for Action {
    fn schema() -> Schema {
        Schema::Object(vec![
            (
                "action",
                Schema::Enum(&[
                    "mark_read",
                    "mark_unread",
                    "flag",
                    "unflag",
                    "archive",
                    "delete",
                ]),
            ),
            ("undoable", default(Schema::Bool, json!(false))),
        ])
    }
}
impl Validated for Tier {
    fn schema() -> Schema {
        Schema::Object(vec![("tier", nullable(Schema::Tier))])
    }
}
impl Validated for ThreadActionInput {
    fn schema() -> Schema {
        Schema::Object(vec![
            (
                "view",
                default(
                    Schema::Enum(&["l1", "l2", "l3", "unclassified", "all", "sent", "trash"]),
                    json!("l1"),
                ),
            ),
            ("accountId", optional(uuid())),
            ("action", Schema::Enum(&["archive", "delete"])),
            ("undoable", default(Schema::Bool, json!(false))),
        ])
    }
}
impl Validated for ThreadQuery {
    fn schema() -> Schema {
        Schema::Object(vec![(
            "trash",
            default(Schema::Enum(&["true", "false"]), json!("false")),
        )])
    }
}
impl Validated for SendQuery {
    fn schema() -> Schema {
        Schema::Object(vec![(
            "undoable",
            optional(Schema::Enum(&["true", "false"])),
        )])
    }
}
impl Validated for Callback {
    fn schema() -> Schema {
        Schema::Object(vec![("code", string(1, None)), ("state", string(1, None))])
    }
}
impl Validated for ListInput {
    fn schema() -> Schema {
        Schema::Object(vec![
            (
                "view",
                default(
                    Schema::Enum(&["l1", "l2", "l3", "unclassified", "all", "sent", "trash"]),
                    json!("l1"),
                ),
            ),
            ("accountId", optional(uuid())),
            ("cursor", optional(string(0, None))),
            ("limit", default(Schema::Number, json!(50))),
        ])
    }
}
impl Validated for SearchInput {
    fn schema() -> Schema {
        Schema::Object(vec![
            (
                "q",
                Schema::String {
                    min: 1,
                    max: Some(500),
                    trim: true,
                    format: None,
                },
            ),
            ("accountId", optional(uuid())),
            ("tier", optional(Schema::Tier)),
            ("after", optional(Schema::Date)),
            ("before", optional(Schema::Date)),
            ("hasAttachment", optional(Schema::CoerceBool)),
            ("limit", default(Schema::Number, json!(50))),
        ])
    }
}
fn addresses() -> Schema {
    Schema::Array(Box::new(Schema::Object(vec![
        ("name", default(string(0, None), json!(""))),
        (
            "address",
            Schema::String {
                min: 0,
                max: None,
                trim: false,
                format: Some("email"),
            },
        ),
    ])))
}
impl Validated for DraftInput {
    fn schema() -> Schema {
        Schema::Object(vec![
            ("id", optional(uuid())),
            ("accountId", uuid()),
            ("to", default(addresses(), json!([]))),
            ("cc", default(addresses(), json!([]))),
            ("bcc", default(addresses(), json!([]))),
            ("subject", default(string(0, Some(998)), json!(""))),
            ("body", default(string(0, Some(2_000_000)), json!(""))),
            ("replyToMessageId", default(nullable(uuid()), Value::Null)),
            ("forwardOfMessageId", default(nullable(uuid()), Value::Null)),
        ])
    }
}

pub struct ApiError(anyhow::Error);
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let text = self.0.to_string();
        let (status, message) = match text.as_str() {
            "Invalid request" => (StatusCode::BAD_REQUEST, "Invalid request"),
            "Message not found" => (StatusCode::NOT_FOUND, "Message not found"),
            "This action is already pending" => {
                (StatusCode::CONFLICT, "This action is already pending")
            }
            "Undo window expired" => (StatusCode::CONFLICT, "This action can no longer be undone."),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong"),
        };
        error(status, message)
    }
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

pub fn router(state: Shared) -> Router {
    let root = state.config.web_dist_path.clone();
    let index = Router::new()
        .fallback_service(
            ServeFile::new(root.join("index.html"))
                .precompressed_br()
                .precompressed_gzip(),
        )
        .layer(middleware::from_fn(index_headers));
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route(
            "/api/auth/session",
            get(|| async { Json(json!({"authenticated":true})) }),
        )
        .route("/api/accounts", get(accounts))
        .route("/api/live", get(crate::live::upgrade))
        .route("/api/sync/snapshot", get(crate::sync::snapshot))
        .route("/api/sync/delta", get(crate::sync::delta))
        .route("/api/sync/bodies", get(crate::sync::bodies))
        .route("/api/messages", get(messages))
        .route("/api/messages/{id}", get(message))
        .route("/api/threads/{id}", get(thread))
        .route("/api/threads/{id}/action", post(thread_action))
        .route("/api/messages/{id}/action", post(action))
        .route("/api/mutations/{id}/undo", post(undo))
        .route("/api/messages/{id}/tier", put(tier))
        .route("/api/search", get(search))
        .route("/api/drafts", get(drafts).post(create_draft))
        .route(
            "/api/drafts/{id}",
            get(get_draft).put(update_draft).delete(delete_draft),
        )
        .route("/api/drafts/{id}/send", post(send))
        .route(
            "/api/messages/{id}/attachments/{attachment_id}",
            get(attachment),
        )
        .route("/api/oauth/{provider}/start", get(oauth_start))
        .route("/api/oauth/{provider}/callback", get(oauth_callback))
        .fallback_service(
            ServeDir::new(&root)
                .precompressed_br()
                .precompressed_gzip()
                .fallback(index),
        )
        .layer(middleware::from_fn(static_headers))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), protect))
        .with_state(state)
}

async fn static_headers(mut request: Request, next: Next) -> Response {
    let api = request.uri().path().starts_with("/api/");
    let asset = request.uri().path().starts_with("/assets/");
    let worker = request.uri().path() == "/sw.js";
    if worker {
        request.headers_mut().remove(header::IF_MODIFIED_SINCE);
        request.headers_mut().remove(header::IF_NONE_MATCH);
    }
    let mut response = next.run(request).await;
    if !api && (response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED) {
        response
            .headers_mut()
            .entry(header::CACHE_CONTROL)
            .or_insert(if worker {
                "no-store".parse().unwrap()
            } else if asset {
                "public, max-age=31536000, immutable".parse().unwrap()
            } else {
                "no-cache".parse().unwrap()
            });
        response
            .headers_mut()
            .append(header::VARY, "Accept-Encoding".parse().unwrap());
    }
    response
}

async fn index_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    response
}

async fn protect(
    ExtractState(state): ExtractState<Shared>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path.starts_with("/api/") {
        let public = path == "/api/health"
            || path == "/api/auth/login"
            || (path.starts_with("/api/oauth/") && path.ends_with("/callback"));
        let session = auth::token(request.headers())
            .and_then(|token| auth::session_info(token, state.secret()));
        if !public {
            let Some(session) = session else {
                return error(StatusCode::UNAUTHORIZED, "Authentication required");
            };
            match state.session_valid(&session).await {
                Ok(true) => {}
                Ok(false) => return error(StatusCode::UNAUTHORIZED, "Authentication required"),
                Err(_) => {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Authentication temporarily unavailable",
                    );
                }
            }
        }
        if !["GET", "HEAD", "OPTIONS"].contains(&request.method().as_str())
            && path != "/api/auth/login"
            && request
                .headers()
                .get("x-sent-request")
                .is_none_or(|v| v != "1")
        {
            return error(StatusCode::FORBIDDEN, "Missing request protection header");
        }
        if request
            .extensions()
            .get::<axum::extract::MatchedPath>()
            .is_none()
        {
            if state.config.web_dist_path.is_dir() {
                return error(StatusCode::NOT_FOUND, "Not found");
            }
            return (StatusCode::NOT_FOUND,Json(json!({"message":format!("Route {}:{} not found",request.method(),request.uri()),"error":"Not Found","statusCode":404}))).into_response();
        }
        let segments: Vec<_> = path.split('/').collect();
        if segments.len() > 3
            && ["messages", "threads", "mutations", "drafts"].contains(&segments[2])
            && let Err(response) = validation::path(
                Schema::Object(vec![("id", uuid())]),
                &json!({"id":segments[3]}),
            )
        {
            return *response;
        }
        if segments.len() > 3
            && segments[2] == "oauth"
            && let Err(response) = validation::path(
                Schema::Object(vec![("provider", Schema::Enum(&["gmail", "microsoft"]))]),
                &json!({"provider":segments[3]}),
            )
        {
            return *response;
        }
    }
    next.run(request).await
}

#[derive(Deserialize)]
struct Login {
    password: String,
}

async fn login(
    ExtractState(state): ExtractState<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    input: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Response> {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.split(',').next())
        .map(str::to_owned)
        .unwrap_or_else(|| peer.ip().to_string());
    let attempts = {
        let mut logins = state.logins.lock().expect("login limiter poisoned");
        logins.retain(|_, (start, _)| start.elapsed() < StdDuration::from_secs(60));
        let entry = logins.entry(ip).or_insert((Instant::now(), 0));
        entry.1 += 1;
        entry.1
    };
    if attempts > 5 {
        return Ok(error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Something went wrong",
        ));
    }
    let input = match input {
        Ok(Json(value)) => value,
        Err(_) => {
            return Ok(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong",
            ));
        }
    };
    let input: Login = match validation::validate(&input) {
        Ok(input) => input,
        Err(response) => return Ok(*response),
    };
    let hash = state
        .config
        .password_hash
        .clone()
        .expect("validated password hash");
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(anyhow::Error::from)?;
    if !valid {
        return Ok(error(StatusCode::UNAUTHORIZED, "Incorrect password"));
    }
    let token = auth::session(state.secret())?;
    Ok((
        [(header::SET_COOKIE, state.cookie(Some(&token)))],
        Json(json!({"ok":true})),
    )
        .into_response())
}

async fn logout(ExtractState(state): ExtractState<Shared>, headers: HeaderMap) -> Response {
    if let Some(session) =
        auth::token(&headers).and_then(|token| auth::session_info(token, state.secret()))
    {
        if sent_core::live::revoke_session(&state.repository.0, &session.key, session.expires)
            .await
            .is_err()
        {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Logout temporarily unavailable",
            );
        }
        state.live.revoke(session.key.clone(), session.expires);
        if let Err(error) =
            sent_core::live::notify_logout(&state.repository.0, &session.key, session.expires).await
        {
            eprintln!("Live logout notification failed: {error}");
        }
    }
    (
        [(header::SET_COOKIE, state.cookie(None))],
        Json(json!({"ok":true})),
    )
        .into_response()
}
async fn health(ExtractState(state): ExtractState<Shared>) -> Json<Value> {
    Json(state.repository.health().await.unwrap_or_else(|_|json!({"status":"degraded","database":false,"workerHeartbeat":null,"failedMutations":0,"classificationFailures":0,"sync":{"accounts":0,"needsReauth":0,"oldestSuccessfulSyncAt":null,"stale":0,"fresh":false}})))
}
async fn accounts(ExtractState(state): ExtractState<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"accounts":state.repository.list_accounts().await?}),
    ))
}
async fn messages(
    ExtractState(state): ExtractState<Shared>,
    ZodQuery(input): ZodQuery<ListInput>,
) -> ApiResult<Json<Value>> {
    Ok(Json(state.repository.list_messages(input).await?))
}
async fn message(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    Ok(
        match state
            .repository
            .get_message_with_state(id, cache_requested(&headers))
            .await?
        {
            Some(value) => Json(value).into_response(),
            None => error(StatusCode::NOT_FOUND, "Message not found"),
        },
    )
}
#[derive(Deserialize)]
struct ThreadQuery {
    trash: Option<String>,
}
async fn thread(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ZodQuery(input): ZodQuery<ThreadQuery>,
) -> ApiResult<Json<Value>> {
    if input
        .trash
        .as_ref()
        .is_some_and(|v| v != "true" && v != "false")
    {
        return Err(anyhow::anyhow!("Invalid request").into());
    }
    Ok(Json(
        json!({"messages":state.repository.get_thread_with_state(id,input.trash.as_deref()==Some("true"),cache_requested(&headers)).await?}),
    ))
}
#[derive(Deserialize)]
struct Action {
    action: String,
    #[serde(default)]
    undoable: bool,
}
async fn thread_action(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ZodJson(input): ZodJson<ThreadActionInput>,
) -> ApiResult<Response> {
    let until = input.undoable.then(|| Utc::now() + Duration::seconds(5));
    let mutation = state
        .repository
        .enqueue_thread_action(id, &input, until)
        .await?;
    cached_receipt(&state, mutation, until, &headers).await
}
async fn action(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ZodJson(input): ZodJson<Action>,
) -> ApiResult<Response> {
    let until = if input.undoable && ["archive", "delete"].contains(&input.action.as_str()) {
        Some(Utc::now() + Duration::seconds(5))
    } else {
        None
    };
    let mutation = state
        .repository
        .enqueue_action(id, &input.action, until)
        .await?;
    cached_receipt(&state, mutation, until, &headers).await
}
fn cache_requested(headers: &HeaderMap) -> bool {
    headers
        .get("x-sent-cache")
        .is_some_and(|value| value == "1")
}
async fn cached_receipt(
    state: &State,
    id: Uuid,
    until: Option<chrono::DateTime<Utc>>,
    headers: &HeaderMap,
) -> ApiResult<Response> {
    if !cache_requested(headers) {
        return Ok(receipt(id, until));
    }
    let ids = state.repository.mutation_message_ids(id).await?;
    let mut value = json!({"mutationId":id,"patches":state.repository.message_states(&ids).await?});
    if let Some(until) = until {
        value["undoUntil"] = json!(timestamp(until));
    }
    Ok((StatusCode::ACCEPTED, Json(value)).into_response())
}
fn receipt(id: Uuid, until: Option<chrono::DateTime<Utc>>) -> Response {
    let mut value = json!({"mutationId":id});
    if let Some(until) = until {
        value["undoUntil"] = json!(timestamp(until));
    }
    (StatusCode::ACCEPTED, Json(value)).into_response()
}
async fn undo(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let ids = if cache_requested(&headers) {
        state.repository.mutation_message_ids(id).await?
    } else {
        Vec::new()
    };
    let mut value = json!({"draft":state.repository.undo(id).await?});
    if cache_requested(&headers) {
        value["patches"] = state.repository.message_states(&ids).await?;
    }
    Ok(Json(value))
}
#[derive(Deserialize)]
struct Tier {
    tier: Option<i32>,
}
async fn tier(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    ZodJson(input): ZodJson<Tier>,
) -> ApiResult<Json<Value>> {
    state.repository.set_tier(id, input.tier).await?;
    let mut value = json!({"ok":true});
    if cache_requested(&headers) {
        value["patches"] = state.repository.message_states(&[id]).await?;
    }
    Ok(Json(value))
}
async fn search(
    ExtractState(state): ExtractState<Shared>,
    ZodQuery(input): ZodQuery<SearchInput>,
) -> ApiResult<Json<Value>> {
    let embedding = if let Some(key) = &state.config.openai_api_key {
        let result = state
            .http
            .post("https://api.openai.com/v1/embeddings")
            .bearer_auth(key)
            .json(&json!({"model":state.config.embedding_model,"input":input.q,"dimensions":3072}))
            .send()
            .await;
        match result {
            Ok(response) => response.json::<Value>().await.ok().and_then(|v| {
                v["data"][0]["embedding"]
                    .as_array()
                    .and_then(|a| a.iter().map(Value::as_f64).collect())
            }),
            Err(_) => None,
        }
    } else {
        None
    };
    if embedding.is_some()
        && let Ok(result) = state.repository.search(&input, embedding).await
    {
        return Ok(Json(result));
    }
    Ok(Json(state.repository.search(&input, None).await?))
}
async fn drafts(ExtractState(state): ExtractState<Shared>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"drafts":state.repository.list_drafts().await?}),
    ))
}
async fn get_draft(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
) -> ApiResult<Response> {
    Ok(match state.repository.get_draft(id).await? {
        Some(value) => Json(value).into_response(),
        None => error(StatusCode::NOT_FOUND, "Draft not found"),
    })
}
async fn create_draft(
    ExtractState(state): ExtractState<Shared>,
    ZodJson(input): ZodJson<DraftInput>,
) -> ApiResult<Json<Value>> {
    Ok(Json(state.repository.save_draft(input).await?))
}
async fn update_draft(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    ZodJson(mut input): ZodJson<DraftInput>,
) -> ApiResult<Json<Value>> {
    input.id = Some(id);
    Ok(Json(state.repository.save_draft(input).await?))
}
async fn delete_draft(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.repository.delete_draft(id).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
struct SendQuery {
    undoable: Option<String>,
}
async fn send(
    ExtractState(state): ExtractState<Shared>,
    Path(id): Path<Uuid>,
    ZodQuery(query): ZodQuery<SendQuery>,
    multipart: Option<Multipart>,
) -> ApiResult<Response> {
    if state.repository.get_draft(id).await?.is_none() {
        return Ok(error(StatusCode::NOT_FOUND, "Draft not found"));
    }
    let mut attachments = Vec::new();
    let mut bytes = 0;
    if let Some(mut multipart) = multipart {
        let mut parts = 0;
        while let Some(mut field) = multipart.next_field().await.map_err(anyhow::Error::from)? {
            parts += 1;
            if parts > 10 {
                return Ok(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Attach at most 10 files",
                ));
            }
            let Some(filename) = field.file_name().map(str::to_owned) else {
                continue;
            };
            let content_type = field
                .content_type()
                .unwrap_or("application/octet-stream")
                .to_owned();
            let mut content = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(anyhow::Error::from)? {
                bytes += chunk.len();
                if bytes > 20 * 1024 * 1024 {
                    return Ok(error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "Attachments exceed the 20 MB Sent limit",
                    ));
                }
                content.extend_from_slice(&chunk);
            }
            attachments.push(json!({"filename":filename,"contentType":content_type,"contentBase64":STANDARD.encode(content)}));
        }
    }
    if query
        .undoable
        .as_ref()
        .is_some_and(|v| v != "true" && v != "false")
    {
        return Err(anyhow::anyhow!("Invalid request").into());
    }
    let until = if query.undoable.as_deref() == Some("true") {
        Some(Utc::now() + Duration::seconds(5))
    } else {
        None
    };
    Ok(receipt(
        state
            .repository
            .enqueue_send(id, json!(attachments), until)
            .await?,
        until,
    ))
}

async fn attachment(
    ExtractState(state): ExtractState<Shared>,
    Path((id, attachment_id)): Path<(Uuid, String)>,
) -> ApiResult<Response> {
    if state.repository.get_message(id).await?.is_none() {
        return Ok(error(StatusCode::NOT_FOUND, "Message not found"));
    }
    let attachment = state.providers.fetch_attachment(id, &attachment_id).await?;
    let filename: String = attachment
        .filename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~!()*'".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok((
        [
            (header::CONTENT_TYPE, attachment.content_type),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{filename}"),
            ),
        ],
        Body::from(attachment.bytes),
    )
        .into_response())
}

fn provider_valid(provider: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        ["gmail", "microsoft"].contains(&provider),
        "Invalid request"
    );
    Ok(())
}
async fn oauth_start(
    ExtractState(state): ExtractState<Shared>,
    Path(provider): Path<String>,
) -> ApiResult<Json<Value>> {
    provider_valid(&provider)?;
    let token = auth::oauth(&provider, state.secret())?;
    let redirect = format!("{}/api/oauth/{provider}/callback", state.config.public_url);
    let (base, client, scope, prompt) = if provider == "gmail" {
        ("https://accounts.google.com/o/oauth2/v2/auth".to_owned(),Config::required(&state.config.google_client_id,"GOOGLE_CLIENT_ID")?,"https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send openid email profile".to_owned(),"consent")
    } else {
        (
            format!(
                "https://login.microsoftonline.com/{}/oauth2/v2.0/authorize",
                state.config.microsoft_tenant_id
            ),
            Config::required(&state.config.microsoft_client_id, "MICROSOFT_CLIENT_ID")?,
            format!(
                "openid profile offline_access Mail.ReadWrite{}",
                if state.config.microsoft_mail_send_enabled {
                    " Mail.Send"
                } else {
                    ""
                }
            ),
            "select_account",
        )
    };
    let mut url = reqwest::Url::parse(&base).map_err(anyhow::Error::from)?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", client),
        ("redirect_uri", &redirect),
        ("response_type", "code"),
        ("scope", &scope),
        ("state", &token),
        ("prompt", prompt),
    ]);
    if provider == "gmail" {
        url.query_pairs_mut().append_pair("access_type", "offline");
    }
    Ok(Json(json!({"url":url.as_str()})))
}
#[derive(Deserialize)]
struct Callback {
    code: String,
    state: String,
}
async fn oauth_callback(
    ExtractState(state): ExtractState<Shared>,
    Path(provider): Path<String>,
    ZodQuery(query): ZodQuery<Callback>,
) -> ApiResult<Response> {
    provider_valid(&provider)?;
    auth::verify_oauth(&query.state, &provider, state.secret())?;
    if query.code.is_empty() {
        return Err(anyhow::anyhow!("Invalid request").into());
    }
    state
        .providers
        .exchange_code(&provider, &query.code)
        .await?;
    let url = reqwest::Url::parse(&state.config.web_url)
        .map_err(anyhow::Error::from)?
        .join("/settings?connected=1")
        .map_err(anyhow::Error::from)?;
    Ok((StatusCode::FOUND, [(header::LOCATION, url.to_string())]).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn authenticated_pool() -> (tempfile::TempDir, sqlx::SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = sent_core::db::pool(directory.path().join("app.sqlite").to_str().unwrap(), true)
            .await
            .unwrap();
        sent_core::db::migrate(
            &pool,
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../migrations"),
        )
        .await
        .unwrap();
        (directory, pool)
    }

    #[tokio::test]
    async fn logout_is_enforced_without_a_listener_and_after_server_restart() -> anyhow::Result<()>
    {
        let (_database, pool) = authenticated_pool().await;
        let mut config = Config::from_env()?;
        config.session_secret = Some("test-session-secret-at-least-32-characters".into());
        let token = auth::session(config.session_secret.as_deref().unwrap())?;
        let session =
            auth::session_info(&token, config.session_secret.as_deref().unwrap()).unwrap();
        let mut servers = Vec::new();
        let mut bases = Vec::new();
        let mut states = Vec::new();
        for _ in 0..2 {
            let state = Arc::new(State::new(config.clone(), Repository(pool.clone())));
            let app = router(state.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            bases.push(format!("http://{}", listener.local_addr()?));
            states.push(state);
            servers.push(tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap()
            }));
        }
        let http = reqwest::Client::new();
        assert_eq!(
            http.get(format!("{}/api/auth/session", bases[1]))
                .bearer_auth(&token)
                .send()
                .await?
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            http.post(format!("{}/api/auth/logout", bases[0]))
                .bearer_auth(&token)
                .header("x-sent-request", "1")
                .send()
                .await?
                .status(),
            StatusCode::OK
        );
        assert!(
            states[1].live.valid(&session),
            "The second process missed the notification"
        );
        assert_eq!(
            http.get(format!("{}/api/auth/session", bases[1]))
                .bearer_auth(&token)
                .send()
                .await?
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let restarted = Arc::new(State::new(config.clone(), Repository(pool.clone())));
        assert!(restarted.live.valid(&session));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let app = router(restarted);
        servers.push(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap()
        }));
        assert_eq!(
            http.get(format!("{base}/api/auth/session"))
                .header(header::COOKIE, format!("sent_session={token}"))
                .send()
                .await?
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let other = auth::session(config.session_secret.as_deref().unwrap())?;
        assert_eq!(
            http.get(format!("{base}/api/auth/session"))
                .bearer_auth(&other)
                .send()
                .await?
                .status(),
            StatusCode::OK
        );
        sqlx::query("delete from worker_state where name=?1")
            .bind(format!("session-revoked:{}", session.key))
            .execute(&pool)
            .await?;
        pool.close().await;
        assert_eq!(
            http.get(format!("{base}/api/auth/session"))
                .bearer_auth(&other)
                .send()
                .await?
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            http.post(format!("{base}/api/auth/logout"))
                .bearer_auth(&other)
                .header("x-sent-request", "1")
                .send()
                .await?
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        for server in servers {
            server.abort();
        }
        Ok(())
    }

    #[tokio::test]
    async fn precompressed_assets_and_spa_cache_headers_match_typescript() {
        const CONTENT: &[u8] = b"hello compressed asset";
        const GZIP: &[u8] = &[
            31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 203, 72, 205, 201, 201, 87, 72, 206, 207, 45, 40, 74,
            45, 46, 78, 77, 81, 72, 44, 46, 78, 45, 1, 0, 190, 102, 76, 107, 22, 0, 0, 0,
        ];
        const BROTLI: &[u8] = &[
            27, 21, 0, 248, 37, 65, 200, 202, 114, 16, 78, 128, 201, 115, 56, 26, 9, 231, 129, 222,
            185, 3,
        ];
        let root = std::env::temp_dir().join(format!("sent-compressed-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        for file in ["index.html", "assets/index-abcdefgh.js"] {
            for (suffix, bytes) in [("", CONTENT), (".br", BROTLI), (".gz", GZIP)] {
                std::fs::write(root.join(format!("{file}{suffix}")), bytes).unwrap();
            }
        }
        std::fs::write(root.join("assets/raw-abcdefgh.js"), CONTENT).unwrap();
        std::fs::write(root.join("assets/empty-abcdefgh.js"), b"").unwrap();
        std::fs::write(root.join("sw.js"), "old worker generation").unwrap();
        let mut config = Config::from_env().unwrap();
        config.web_dist_path = root.clone();
        config.session_secret = Some("test-session-secret-at-least-32-characters".into());
        let database = tempfile::tempdir().unwrap();
        let pool = sent_core::db::pool(database.path().join("sent.sqlite").to_str().unwrap(), true)
            .await
            .unwrap();
        let app = router(Arc::new(State::new(config, Repository(pool))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::new();
        let modified = std::fs::metadata(root.join("sw.js"))
            .unwrap()
            .modified()
            .unwrap();
        let previous = http
            .get(format!("{base}/sw.js"))
            .send()
            .await
            .unwrap()
            .headers()[header::LAST_MODIFIED]
            .clone();
        std::fs::write(root.join("sw.js"), "new worker generation").unwrap();
        std::fs::File::open(root.join("sw.js"))
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let worker = http
            .get(format!("{base}/sw.js"))
            .header(header::IF_MODIFIED_SINCE, previous)
            .send()
            .await
            .unwrap();
        assert_eq!(worker.status(), StatusCode::OK);
        assert_eq!(worker.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(worker.text().await.unwrap(), "new worker generation");
        for (accept, encoding, bytes) in [
            ("br, gzip", Some("br"), BROTLI),
            ("gzip", Some("gzip"), GZIP),
            ("", None, CONTENT),
            ("identity", None, CONTENT),
            ("br;q=0, gzip;q=0", None, CONTENT),
        ] {
            let response = http
                .get(format!("{base}/assets/index-abcdefgh.js"))
                .header(header::ACCEPT_ENCODING, accept)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response
                    .headers()
                    .get(header::CONTENT_ENCODING)
                    .map(|v| v.to_str().unwrap()),
                encoding
            );
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            assert!(
                response.headers()[header::VARY]
                    .to_str()
                    .unwrap()
                    .to_lowercase()
                    .contains("accept-encoding")
            );
            assert!(
                response.headers()[header::CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .contains("javascript")
            );
            assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
        }
        for path in ["/", "/index.html", "/inbox/thread", "/assets/missing.js"] {
            let response = http
                .get(format!("{base}{path}"))
                .header(header::ACCEPT_ENCODING, "br, gzip")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
            assert!(
                response.headers()[header::CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .starts_with("text/html")
            );
            assert_eq!(response.bytes().await.unwrap().as_ref(), BROTLI);
        }
        for path in ["raw", "empty"] {
            let response = http
                .get(format!("{base}/assets/{path}-abcdefgh.js"))
                .header(header::ACCEPT_ENCODING, "br, gzip")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
            assert_eq!(
                response.bytes().await.unwrap().as_ref(),
                if path == "raw" { CONTENT } else { b"" }
            );
        }
        let response = http
            .get(format!("{base}/api/private"))
            .header(header::ACCEPT_ENCODING, "br, gzip")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
        assert!(response.headers().get(header::CACHE_CONTROL).is_none());
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn spa_routes_return_index_with_ok_status_and_preserve_api_boundaries() {
        let (_database, pool) = authenticated_pool().await;
        let root = std::env::temp_dir().join(format!("sent-spa-{}", Uuid::new_v4()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<main>Sent</main>").unwrap();
        std::fs::write(root.join("assets/app.css"), "body { color: black; }").unwrap();
        let mut config = Config::from_env().unwrap();
        config.web_dist_path = root.clone();
        config.session_secret = Some("test-session-secret-at-least-32-characters".into());
        let token = auth::session(config.session_secret.as_deref().unwrap()).unwrap();
        let app = router(Arc::new(State::new(config, Repository(pool))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::new();
        for path in ["/", "/settings", "/inbox/l1", "/search?q=hello"] {
            let response = http.get(format!("{base}{path}")).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
            assert_eq!(response.text().await.unwrap(), "<main>Sent</main>");
        }
        let response = http.head(format!("{base}/settings")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.bytes().await.unwrap().is_empty());
        let response = http
            .get(format!("{base}/assets/app.css"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "body { color: black; }");
        let response = http
            .get(format!("{base}/api/missing"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = http
            .get(format!("{base}/api/missing"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":"Not found"})
        );
        std::fs::remove_file(root.join("index.html")).unwrap();
        let response = http.get(format!("{base}/settings")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn middleware_preserves_api_html_and_auth_boundaries() {
        let (_database, pool) = authenticated_pool().await;
        let mut config = Config::from_env().unwrap();
        config.session_secret = Some("test-session-secret-at-least-32-characters".into());
        let token = auth::session(config.session_secret.as_deref().unwrap()).unwrap();
        let state = Arc::new(State::new(config, Repository(pool)));
        let app = Router::new()
            .route(
                "/api/html",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "<p>attachment</p>") }),
            )
            .route("/api/empty", get(|| async { StatusCode::NO_CONTENT }))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(middleware::from_fn_with_state(state.clone(), protect))
            .with_state(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = reqwest::Client::new();
        let response = http
            .get(format!("{base}/api/html"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
        assert_eq!(response.text().await.unwrap(), "<p>attachment</p>");
        let response = http
            .get(format!("{base}/api/empty"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response.bytes().await.unwrap().is_empty());
        let response = http.get(format!("{base}/api/html")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error":"Authentication required"})
        );
        let response = http
            .get(format!("{base}/api/missing"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        server.abort();
    }
}
