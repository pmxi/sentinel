use crate::db::Uuid;
use crate::{
    ai::Intelligence,
    config::Config,
    ingest::{Container, NormalizedMessage, StoredAccount},
    normalize::{analysis_text, content_hash, snippet},
    providers::{OutgoingAttachment, OutgoingMessage, Providers},
    repository::{Address, Classification, DraftInput, Repository},
};
use anyhow::{Context, Result, ensure};
use chrono::Utc;
use serde_json::{Value, json};

#[derive(Clone)]
pub struct Services {
    pub repository: Repository,
    pub providers: Providers,
    pub intelligence: Intelligence,
    pub config: Config,
}

pub fn needs_reauth(error: &str) -> bool {
    let error = error.to_lowercase();
    [
        "invalid_grant",
        "interaction_required",
        "unauthorized",
        "401",
    ]
    .iter()
    .any(|s| error.contains(s))
}

impl Services {
    pub fn new(config: Config, repository: Repository) -> Self {
        Self {
            providers: Providers::new(config.clone(), repository.0.clone()),
            intelligence: Intelligence::new(config.clone()),
            repository,
            config,
        }
    }
    pub async fn sync_account(&self, id: Uuid) -> Result<Vec<Uuid>> {
        let account = self
            .repository
            .get_stored_account(id)
            .await?
            .context("Account not found")?;
        let (cursor, _) = self.repository.get_sync_cursor(id).await?;
        let result = async {
            let page = self.providers.sync(&account, cursor.as_deref()).await?;
            self.repository
                .tombstone_messages(id, &page.deleted_provider_message_ids)
                .await?;
            let mut changed = vec![];
            for message in page.messages {
                let (id, change) = self.repository.upsert_message(id, &message).await?;
                if change {
                    changed.push(id);
                }
            }
            self.repository
                .finish_sync(id, page.next_cursor.as_deref(), page.backfill_complete)
                .await?;
            Ok::<_, anyhow::Error>(changed)
        }
        .await;
        if let Err(error) = &result {
            self.repository
                .fail_sync(id, &error.to_string(), needs_reauth(&error.to_string()))
                .await?;
        }
        result
    }
    pub async fn classify_message(&self, id: Uuid) -> Result<()> {
        let Some(message) = self.repository.get_analysis_message(id).await? else {
            return Ok(());
        };
        let result = async {
            let result = self.intelligence.classify(&analysis_text(&message)).await?;
            self.repository
                .save_classification(
                    id,
                    Classification {
                        tier: result.tier,
                        reasoning: &result.reasoning,
                        summary: &result.summary,
                        plain_text: &result.plain_text,
                        model: &result.model,
                        prompt_version: &result.prompt_version,
                    },
                )
                .await
        }
        .await;
        if let Err(error) = &result {
            self.repository
                .save_classification_failure(id, &error.to_string())
                .await?;
        }
        result
    }
    pub async fn embed_message(&self, id: Uuid) -> Result<()> {
        let Some(message) = self.repository.get_analysis_message(id).await? else {
            return Ok(());
        };
        let text = analysis_text(&message);
        let (embedding, model) = self.intelligence.embed(&text).await?;
        self.repository
            .save_embedding(id, &embedding, &model, &content_hash(&text))
            .await
    }
    async fn fake_sent(
        &self,
        account: &StoredAccount,
        draft: &DraftInput,
        attachments: &[OutgoingAttachment],
        mutation: Uuid,
    ) -> Result<()> {
        let now = Utc::now();
        let thread = if let Some(original) = draft.reply_to_message_id {
            sqlx::query_scalar::<_,String>("select t.provider_thread_id from messages m join threads t on t.id=m.thread_id where m.id=?1 and m.account_id=?2").bind(original).bind(account.id).fetch_optional(&self.repository.0).await?.unwrap_or_else(||format!("fake-thread-{mutation}"))
        } else {
            format!("fake-thread-{mutation}")
        };
        let sent=NormalizedMessage{provider_message_id:format!("fake-sent-{mutation}"),provider_thread_id:thread,internet_message_id:Some(format!("<{mutation}@sent-fake.example>")),subject:draft.subject.clone(),from:vec![Address{name:account.display_name.clone(),address:account.email.clone()}],to:draft.to.clone(),cc:draft.cc.clone(),bcc:draft.bcc.clone(),sent_at:Some(now),received_at:now,snippet:snippet(&draft.body),text_body:draft.body.clone(),html_body:None,headers:json!({}),attachments:json!(attachments.iter().enumerate().map(|(i,a)| json!({"id":format!("fake-sent-attachment-{mutation}-{i}"),"filename":a.filename,"contentType":a.content_type,"size":base64::Engine::decode(&base64::engine::general_purpose::STANDARD,&a.content_base64).map(|v|v.len()).unwrap_or(0),"inline":false,"contentId":null})).collect::<Vec<_>>()),direction:"outbound".into(),read:true,flagged:false,archived:false,deleted:false,tombstone:false,native_state:json!({"fake":true,"isSent":true}),provider_updated_at:Some(now),containers:vec![Container{id:if account.provider=="gmail"{"SENT"}else{"sentitems"}.into(),name:"Sent Items".into(),kind:if account.provider=="gmail"{"label"}else{"folder"}.into()}]};
        self.repository.upsert_message(account.id, &sent).await?;
        Ok(())
    }
    async fn process_mutation(&self, item: &Value) -> Result<()> {
        let id: Uuid = serde_json::from_value(item["id"].clone())?;
        let account_id: Uuid = serde_json::from_value(item["accountId"].clone())?;
        let account = self
            .repository
            .get_stored_account(account_id)
            .await?
            .context("Mutation account no longer exists")?;
        let action = item["action"].as_str().context("Mutation missing action")?;
        if action == "send" {
            let payload = &item["payload"];
            ensure!(
                !payload["draft"].is_null(),
                "Send mutation is missing its draft"
            );
            ensure!(
                payload["sendAttemptedAt"].is_null(),
                "This send was already attempted; delivery requires reconciliation"
            );
            let draft: DraftInput = serde_json::from_value(payload["draft"].clone())?;
            let attachments: Vec<OutgoingAttachment> = serde_json::from_value(
                payload["attachments"]
                    .as_array()
                    .cloned()
                    .map(Value::Array)
                    .unwrap_or_else(|| json!([])),
            )?;
            let mut message = OutgoingMessage {
                from: account.email.clone(),
                to: draft.to.clone(),
                cc: draft.cc.clone(),
                bcc: draft.bcc.clone(),
                subject: draft.subject.clone(),
                body: draft.body.clone(),
                in_reply_to: None,
                reply_to_provider_message_id: None,
                forward_of_provider_message_id: None,
                references: vec![],
                attachments,
            };
            if let Some(original) = draft.reply_to_message_id {
                message.in_reply_to = self
                    .repository
                    .get_message(original)
                    .await?
                    .and_then(|v| v["internetMessageId"].as_str().map(str::to_owned));
                message.reply_to_provider_message_id = self
                    .repository
                    .get_provider_message_reference(original)
                    .await?
                    .map(|r| r.0);
                if let Some(id) = &message.in_reply_to {
                    message.references.push(id.clone());
                }
            }
            if let Some(original) = draft.forward_of_message_id {
                message.forward_of_provider_message_id = self
                    .repository
                    .get_provider_message_reference(original)
                    .await?
                    .map(|r| r.0);
            }
            let sent = self
                .providers
                .send(&account, &message, || {
                    self.repository.record_send_attempt(id)
                })
                .await?;
            if self.config.fake_providers {
                self.fake_sent(&account, &draft, &message.attachments, id)
                    .await?;
            }
            self.repository.complete_mutation(id).await?;
            if !self.config.fake_providers
                && account.provider == "microsoft"
                && let Ok(Some(message)) = self.providers.refetch_sent(&account, &sent).await
            {
                let _ = self.repository.upsert_message(account.id, &message).await;
            }
        } else {
            let message_id: Uuid = serde_json::from_value(item["messageId"].clone())
                .context("Message mutation is missing its message id")?;
            let (reference, _) = self
                .repository
                .get_provider_message_reference(message_id)
                .await?
                .context("Mutation message no longer exists")?;
            self.providers
                .apply_action(&account, &reference, action)
                .await?;
            self.repository.complete_mutation(id).await?;
        }
        Ok(())
    }
    pub async fn process_outbox(&self) -> Result<usize> {
        let items = self.repository.claim_mutations(20).await?;
        for item in &items {
            if let Err(error) = self.process_mutation(item).await {
                self.repository
                    .fail_mutation(
                        serde_json::from_value(item["id"].clone())?,
                        &error.to_string(),
                    )
                    .await?;
            }
        }
        Ok(items.len())
    }
}
