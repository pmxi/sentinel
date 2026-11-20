use super::*;
use crate::{ingest::StoredAccount, normalize::gmail_message};
use reqwest::Method;
use std::collections::BTreeSet;

pub(super) async fn response_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response.text().await?;
    ensure!(
        status.is_success(),
        "Provider HTTP {}: {}",
        status.as_u16(),
        text.chars().take(500).collect::<String>()
    );
    if text.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_str(&text)?)
    }
}

pub fn encode_segment(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

impl Providers {
    pub(super) async fn api(
        &self,
        token: &str,
        method: Method,
        url: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(token)
            .header("Prefer", "IdType=\"ImmutableId\"");
        if let Some(body) = body {
            request = request.json(&body);
        }
        response_json(request.send().await?).await
    }

    pub async fn sync(&self, account: &StoredAccount, cursor: Option<&str>) -> Result<SyncPage> {
        if self.config.fake_providers {
            return Ok(SyncPage {
                messages: vec![],
                deleted_provider_message_ids: vec![],
                next_cursor: cursor.map(str::to_owned),
                backfill_complete: true,
            });
        }
        let token = self
            .access_token(
                account.id,
                &account.provider,
                &account.encrypted_credentials,
            )
            .await?;
        if account.provider == "gmail" {
            self.gmail_sync(&token, account, cursor).await
        } else {
            self.microsoft_sync(&token, account, cursor).await
        }
    }

    async fn gmail_backfill(
        &self,
        token: &str,
        account: &StoredAccount,
        cursor: Option<&str>,
    ) -> Result<SyncPage> {
        let mut url = reqwest::Url::parse(&format!("{}/users/me/messages", self.endpoints.gmail))?;
        url.query_pairs_mut()
            .extend_pairs([("maxResults", "100"), ("includeSpamTrash", "true")]);
        if let Some(page) = cursor
            .and_then(|s| s.strip_prefix("backfill:"))
            .filter(|s| !s.is_empty())
        {
            url.query_pairs_mut().append_pair("pageToken", page);
        }
        let page = self.api(token, Method::GET, url.as_str(), None).await?;
        let ids: Vec<_> = page["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["id"].as_str())
            .collect();
        let mut messages = vec![];
        for batch in ids.chunks(10) {
            let mut tasks = tokio::task::JoinSet::new();
            for id in batch {
                let this = self.clone();
                let token = token.to_owned();
                let email = account.email.clone();
                let url = format!(
                    "{}/users/me/messages/{}?format=full",
                    self.endpoints.gmail,
                    encode_segment(id)
                );
                tasks.spawn(async move {
                    gmail_message(&this.api(&token, Method::GET, &url, None).await?, &email)
                });
            }
            while let Some(result) = tasks.join_next().await {
                messages.push(result??);
            }
        }
        let (next_cursor, complete) = if let Some(next) = page["nextPageToken"].as_str() {
            (format!("backfill:{next}"), false)
        } else {
            let profile = self
                .api(
                    token,
                    Method::GET,
                    &format!("{}/users/me/profile", self.endpoints.gmail),
                    None,
                )
                .await?;
            (
                format!("history:{}", profile["historyId"].as_str().unwrap_or("")),
                true,
            )
        };
        Ok(SyncPage {
            messages,
            deleted_provider_message_ids: vec![],
            next_cursor: Some(next_cursor),
            backfill_complete: complete,
        })
    }

    async fn gmail_sync(
        &self,
        token: &str,
        account: &StoredAccount,
        cursor: Option<&str>,
    ) -> Result<SyncPage> {
        let Some(cursor) = cursor.filter(|s| !s.starts_with("backfill:")) else {
            return self.gmail_backfill(token, account, cursor).await;
        };
        let history = cursor.strip_prefix("history:").unwrap_or(cursor);
        let mut latest = history.to_owned();
        let mut page_token = None::<String>;
        let mut changed = BTreeSet::new();
        let mut deleted = BTreeSet::new();
        loop {
            let mut url =
                reqwest::Url::parse(&format!("{}/users/me/history", self.endpoints.gmail))?;
            url.query_pairs_mut().append_pair("startHistoryId", history);
            for kind in [
                "messageAdded",
                "messageDeleted",
                "labelAdded",
                "labelRemoved",
            ] {
                url.query_pairs_mut().append_pair("historyTypes", kind);
            }
            if let Some(ref page) = page_token {
                url.query_pairs_mut().append_pair("pageToken", page);
            }
            let response = self.http.get(url).bearer_auth(token).send().await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return self.gmail_backfill(token, account, None).await;
            }
            let page = response_json(response).await?;
            if let Some(id) = page["historyId"].as_str() {
                latest = id.into();
            }
            for entry in page["history"].as_array().into_iter().flatten() {
                for key in [
                    "messagesAdded",
                    "labelsAdded",
                    "labelsRemoved",
                    "messagesDeleted",
                ] {
                    for item in entry[key].as_array().into_iter().flatten() {
                        if let Some(id) = item["message"]["id"].as_str() {
                            if key == "messagesDeleted" {
                                deleted.insert(id.to_owned());
                            } else {
                                changed.insert(id.to_owned());
                            }
                        }
                    }
                }
            }
            page_token = page["nextPageToken"].as_str().map(str::to_owned);
            if page_token.is_none() {
                break;
            }
        }
        let mut messages = vec![];
        for id in changed {
            if deleted.contains(&id) {
                continue;
            }
            let url = format!(
                "{}/users/me/messages/{}?format=full",
                self.endpoints.gmail,
                encode_segment(&id)
            );
            let response = self.http.get(url).bearer_auth(token).send().await?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                deleted.insert(id);
            } else {
                messages.push(gmail_message(
                    &response_json(response).await?,
                    &account.email,
                )?);
            }
        }
        Ok(SyncPage {
            messages,
            deleted_provider_message_ids: deleted.into_iter().collect(),
            next_cursor: Some(format!("history:{latest}")),
            backfill_complete: true,
        })
    }

    pub async fn apply_action(
        &self,
        account: &StoredAccount,
        id: &str,
        action: &str,
    ) -> Result<()> {
        if self.config.fake_providers {
            return Ok(());
        }
        let token = self
            .access_token(
                account.id,
                &account.provider,
                &account.encrypted_credentials,
            )
            .await?;
        if account.provider == "gmail" {
            let body = match action {
                "mark_read" => json!({"removeLabelIds":["UNREAD"]}),
                "mark_unread" => json!({"addLabelIds":["UNREAD"]}),
                "flag" => json!({"addLabelIds":["STARRED"]}),
                "unflag" => json!({"removeLabelIds":["STARRED"]}),
                "archive" => json!({"removeLabelIds":["INBOX"]}),
                "delete" => json!({"addLabelIds":["TRASH"]}),
                _ => bail!("Invalid action"),
            };
            self.api(
                &token,
                Method::POST,
                &format!(
                    "{}/users/me/messages/{}/modify",
                    self.endpoints.gmail,
                    encode_segment(id)
                ),
                Some(body),
            )
            .await?;
        } else {
            let url = format!(
                "{}/me/messages/{}",
                self.endpoints.graph,
                encode_segment(id)
            );
            let (method, url, body) = match action {
                "delete" => (Method::DELETE, url, None),
                "archive" => (
                    Method::POST,
                    format!("{url}/move"),
                    Some(json!({"destinationId":"archive"})),
                ),
                "mark_read" | "mark_unread" => (
                    Method::PATCH,
                    url,
                    Some(json!({"isRead":action=="mark_read"})),
                ),
                "flag" | "unflag" => (
                    Method::PATCH,
                    url,
                    Some(
                        json!({"flag":{"flagStatus":if action=="flag"{"flagged"}else{"notFlagged"}}}),
                    ),
                ),
                _ => bail!("Invalid action"),
            };
            self.api(&token, method, &url, body).await?;
        }
        Ok(())
    }
}
