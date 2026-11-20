use super::*;
use crate::{
    ingest::{NormalizedMessage, StoredAccount},
    normalize::graph_message,
};
use reqwest::Method;
use serde::{Deserialize, Serialize};

const SELECT: &str = "id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,lastModifiedDateTime,bodyPreview,body,isRead,flag,parentFolderId,isDraft,hasAttachments";
const COMPLETE: &[&str] = &[
    "conversationId",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "sentDateTime",
    "receivedDateTime",
    "bodyPreview",
    "body",
    "isRead",
    "flag",
    "parentFolderId",
    "isDraft",
    "hasAttachments",
];

#[derive(Clone, Serialize, Deserialize)]
struct Folder {
    id: String,
    name: String,
    delta: Option<String>,
    next: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    version: u8,
    folders: Vec<Folder>,
    index: usize,
    backfill: bool,
    folder_refresh_at: String,
    sent_folder_id: Option<String>,
}

impl Providers {
    fn graph_url(&self, path: &str) -> String {
        if path.starts_with("http") {
            path.into()
        } else {
            format!("{}{path}", self.endpoints.graph)
        }
    }

    async fn graph(&self, token: &str, path: &str) -> Result<Value> {
        self.graph_api(token, Method::GET, &self.graph_url(path), None)
            .await
    }

    async fn list_folders(&self, token: &str) -> Result<Vec<Folder>> {
        let mut pending=vec!["/me/mailFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount".to_owned()];
        let mut folders = vec![];
        while let Some(url) = pending.pop() {
            let page = self.graph(token, &url).await?;
            if let Some(next) = page["@odata.nextLink"].as_str() {
                pending.push(next.into());
            }
            for folder in page["value"]
                .as_array()
                .context("Microsoft folder page missing value")?
            {
                let id = folder["id"]
                    .as_str()
                    .context("Microsoft folder missing id")?;
                folders.push(Folder {
                    id: id.into(),
                    name: folder["displayName"].as_str().unwrap_or("Folder").into(),
                    delta: None,
                    next: None,
                });
                if folder["childFolderCount"].as_u64().unwrap_or(0) > 0 {
                    pending.push(format!("/me/mailFolders/{}/childFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount",encode_segment(id)));
                }
            }
        }
        Ok(folders)
    }

    async fn full_graph_message(&self, token: &str, id: &str) -> Result<Option<Value>> {
        let url = self.graph_url(&format!(
            "/me/messages/{}?$select={SELECT}",
            encode_segment(id)
        ));
        let response = self
            .http
            .get(url)
            .bearer_auth(token)
            .header("Prefer", "IdType=\"ImmutableId\"")
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(None)
        } else {
            Ok(Some(response_json(response).await?))
        }
    }

    async fn normalize_graph(
        &self,
        token: &str,
        source: &Value,
        email: &str,
        folder: &Folder,
        sent: &str,
    ) -> Result<Option<NormalizedMessage>> {
        if source["isDraft"] == true || source["@removed"].is_object() || !source["id"].is_string()
        {
            return Ok(None);
        }
        let attachments = if source["hasAttachments"] == true {
            let page = self
                .graph(
                    token,
                    &format!(
                        "/me/messages/{}/attachments?$select=id,name,contentType,size,isInline",
                        encode_segment(source["id"].as_str().unwrap())
                    ),
                )
                .await?;
            json!(page["value"].as_array().context("Missing attachment list")?.iter().map(|v|json!({"id":v["id"],"filename":v["name"].as_str().unwrap_or("attachment"),"contentType":v["contentType"].as_str().unwrap_or("application/octet-stream"),"size":v["size"].as_u64().unwrap_or(0),"inline":v["isInline"].as_bool().unwrap_or(false),"contentId":v["contentId"]})).collect::<Vec<_>>())
        } else {
            json!([])
        };
        graph_message(source, email, &folder.id, &folder.name, sent, attachments)
    }

    pub(super) async fn microsoft_sync(
        &self,
        token: &str,
        account: &StoredAccount,
        cursor: Option<&str>,
    ) -> Result<SyncPage> {
        let mut state: Option<Cursor> = cursor.map(serde_json::from_str).transpose()?;
        if let Some(state) = &state {
            ensure!(state.version == 1, "Unsupported Microsoft cursor version");
        }
        let sent = if let Some(id) = state.as_ref().and_then(|s| s.sent_folder_id.clone()) {
            id
        } else {
            self.graph(token, "/me/mailFolders/sentitems?$select=id")
                .await?["id"]
                .as_str()
                .context("Missing Sent Items id")?
                .to_owned()
        };
        if state.is_none() {
            let state = Cursor {
                version: 1,
                folders: self.list_folders(token).await?,
                index: 0,
                backfill: true,
                folder_refresh_at: crate::repository::timestamp(Utc::now()),
                sent_folder_id: Some(sent),
            };
            return Ok(SyncPage {
                messages: vec![],
                deleted_provider_message_ids: vec![],
                next_cursor: Some(serde_json::to_string(&state)?),
                backfill_complete: false,
            });
        }
        let state = state.as_mut().unwrap();
        state.sent_folder_id = Some(sent.clone());
        if !state.backfill
            && crate::normalize::date(&json!(state.folder_refresh_at))
                .is_some_and(|d| Utc::now() - d > chrono::Duration::hours(6))
        {
            let previous = std::mem::take(&mut state.folders);
            state.folders = self
                .list_folders(token)
                .await?
                .into_iter()
                .map(|f| previous.iter().find(|p| p.id == f.id).cloned().unwrap_or(f))
                .collect();
            state.folder_refresh_at = crate::repository::timestamp(Utc::now());
            state.index = state.index.min(state.folders.len().saturating_sub(1));
        }
        let mut messages = vec![];
        let mut deleted = vec![];
        if let Some(folder) = state.folders.get_mut(state.index) {
            let url = folder
                .next
                .clone()
                .or_else(|| folder.delta.clone())
                .unwrap_or_else(|| {
                    format!(
                        "/me/mailFolders/{}/messages/delta?$select={SELECT}&$top=50",
                        encode_segment(&folder.id)
                    )
                });
            let page = self.graph(token, &url).await?;
            for source in page["value"]
                .as_array()
                .context("Microsoft delta missing value")?
            {
                let Some(id) = source["id"].as_str() else {
                    continue;
                };
                if source["@removed"].is_object() {
                    deleted.push(id.to_owned());
                    continue;
                }
                let hydrated = if COMPLETE.iter().any(|field| source.get(field).is_none()) {
                    self.full_graph_message(token, id).await?
                } else {
                    Some(source.clone())
                };
                let Some(hydrated) = hydrated else {
                    deleted.push(id.to_owned());
                    continue;
                };
                if let Some(message) = self
                    .normalize_graph(token, &hydrated, &account.email, folder, &sent)
                    .await?
                {
                    messages.push(message);
                }
            }
            folder.next = page["@odata.nextLink"].as_str().map(str::to_owned);
            if folder.next.is_none() {
                if let Some(delta) = page["@odata.deltaLink"].as_str() {
                    folder.delta = Some(delta.into());
                }
                state.index += 1;
                if state.index >= state.folders.len() {
                    state.index = 0;
                    state.backfill = false;
                }
            }
        } else {
            state.index = 0;
            state.backfill = false;
        }
        Ok(SyncPage {
            messages,
            deleted_provider_message_ids: deleted,
            next_cursor: Some(serde_json::to_string(state)?),
            backfill_complete: !state.backfill,
        })
    }

    pub async fn refetch_sent(
        &self,
        account: &StoredAccount,
        id: &str,
    ) -> Result<Option<NormalizedMessage>> {
        ensure!(!self.config.fake_providers, "Fake providers do not refetch");
        let token = self
            .access_token(
                account.id,
                &account.provider,
                &account.encrypted_credentials,
            )
            .await?;
        let sent = self
            .graph(&token, "/me/mailFolders/sentitems?$select=id")
            .await?["id"]
            .as_str()
            .context("Missing Sent Items id")?
            .to_owned();
        match self.full_graph_message(&token, id).await? {
            None => Ok(None),
            Some(source) => {
                self.normalize_graph(
                    &token,
                    &source,
                    &account.email,
                    &Folder {
                        id: sent.clone(),
                        name: "Sent Items".into(),
                        delta: None,
                        next: None,
                    },
                    &sent,
                )
                .await
            }
        }
    }
}
