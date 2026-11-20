use crate::repository::{Address, Repository};
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: Uuid,
    pub provider: String,
    pub email: String,
    pub display_name: String,
    pub encrypted_credentials: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub provider_message_id: String,
    pub provider_thread_id: String,
    pub internet_message_id: Option<String>,
    pub subject: String,
    pub from: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub sent_at: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub snippet: String,
    pub text_body: String,
    pub html_body: Option<String>,
    pub headers: Value,
    pub attachments: Value,
    pub direction: String,
    pub read: bool,
    pub flagged: bool,
    pub archived: bool,
    pub deleted: bool,
    #[serde(default)]
    pub tombstone: bool,
    pub native_state: Value,
    pub provider_updated_at: Option<DateTime<Utc>>,
    pub containers: Vec<Container>,
}

fn stored(row: &sqlx::postgres::PgRow) -> StoredAccount {
    StoredAccount {
        id: row.get("id"),
        provider: row.get("provider"),
        email: row.get("email"),
        display_name: row.get("display_name"),
        encrypted_credentials: row.get("encrypted_credentials"),
    }
}

impl Repository {
    pub async fn list_stored_accounts(&self) -> Result<Vec<StoredAccount>> {
        Ok(sqlx::query("select id,provider::text,email,display_name,encrypted_credentials from accounts where status!='needs_reauth' order by created_at").fetch_all(&self.0).await?.iter().map(stored).collect())
    }

    pub async fn get_stored_account(&self, id: Uuid) -> Result<Option<StoredAccount>> {
        Ok(sqlx::query("select id,provider::text,email,display_name,encrypted_credentials from accounts where id=$1").bind(id).fetch_optional(&self.0).await?.as_ref().map(stored))
    }

    pub async fn upsert_account(
        &self,
        provider: &str,
        email: &str,
        display_name: &str,
        encrypted_credentials: &str,
    ) -> Result<Uuid> {
        let row=sqlx::query("insert into accounts(provider,email,display_name,encrypted_credentials,status,updated_at) values($1::text::provider,$2,$3,$4,'active',now()) on conflict(provider,email) do update set display_name=excluded.display_name,encrypted_credentials=excluded.encrypted_credentials,status='active',last_error=null,updated_at=now() returning id")
            .bind(provider).bind(email.to_lowercase()).bind(display_name).bind(encrypted_credentials).fetch_one(&self.0).await?;
        let id: Uuid = row.get("id");
        sqlx::query("insert into sync_cursors(account_id) values($1) on conflict do nothing")
            .bind(id)
            .execute(&self.0)
            .await?;
        Ok(id)
    }

    pub async fn update_credentials(&self, id: Uuid, encrypted: &str) -> Result<()> {
        sqlx::query("update accounts set encrypted_credentials=$2,updated_at=now() where id=$1")
            .bind(id)
            .bind(encrypted)
            .execute(&self.0)
            .await?;
        Ok(())
    }

    pub async fn get_sync_cursor(&self, id: Uuid) -> Result<(Option<String>, bool)> {
        Ok(
            sqlx::query("select cursor,backfill_complete from sync_cursors where account_id=$1")
                .bind(id)
                .fetch_optional(&self.0)
                .await?
                .map(|r| (r.get("cursor"), r.get("backfill_complete")))
                .unwrap_or((None, false)),
        )
    }

    pub async fn upsert_message(
        &self,
        account_id: Uuid,
        message: &NormalizedMessage,
    ) -> Result<(Uuid, bool)> {
        let mut tx = self.0.begin().await?;
        let existing=sqlx::query("select id,subject,text_body from messages where account_id=$1 and provider_message_id=$2").bind(account_id).bind(&message.provider_message_id).fetch_optional(&mut *tx).await?;
        let thread=sqlx::query("insert into threads(account_id,provider_thread_id,subject,last_message_at) values($1,$2,$3,$4) on conflict(account_id,provider_thread_id) do update set subject=excluded.subject,last_message_at=greatest(threads.last_message_at,excluded.last_message_at),updated_at=now() returning id")
            .bind(account_id).bind(&message.provider_thread_id).bind(&message.subject).bind(message.received_at).fetch_one(&mut *tx).await?;
        let row=sqlx::query("insert into messages(account_id,thread_id,provider_message_id,internet_message_id,subject,from_addresses,to_addresses,cc_addresses,bcc_addresses,sent_at,received_at,snippet,text_body,html_body,headers,attachments,direction,read,flagged,archived,deleted,tombstone,native_state,provider_updated_at,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text::message_direction,$18,$19,$20,$21,$22,$23,$24,now())
          on conflict(account_id,provider_message_id) do update set thread_id=excluded.thread_id,internet_message_id=excluded.internet_message_id,subject=excluded.subject,from_addresses=excluded.from_addresses,to_addresses=excluded.to_addresses,cc_addresses=excluded.cc_addresses,bcc_addresses=excluded.bcc_addresses,sent_at=excluded.sent_at,received_at=excluded.received_at,snippet=excluded.snippet,text_body=excluded.text_body,html_body=excluded.html_body,headers=excluded.headers,attachments=excluded.attachments,direction=excluded.direction,read=excluded.read,flagged=excluded.flagged,archived=excluded.archived,deleted=excluded.deleted,tombstone=excluded.tombstone,native_state=excluded.native_state,provider_updated_at=excluded.provider_updated_at,updated_at=now() returning id")
            .bind(account_id).bind(thread.get::<Uuid,_>("id")).bind(&message.provider_message_id).bind(&message.internet_message_id).bind(&message.subject)
            .bind(json!(message.from)).bind(json!(message.to)).bind(json!(message.cc)).bind(json!(message.bcc)).bind(message.sent_at).bind(message.received_at).bind(&message.snippet).bind(&message.text_body).bind(&message.html_body).bind(&message.headers).bind(&message.attachments).bind(&message.direction).bind(message.read).bind(message.flagged).bind(message.archived).bind(message.deleted).bind(message.tombstone).bind(&message.native_state).bind(message.provider_updated_at).fetch_one(&mut *tx).await?;
        let id: Uuid = row.get("id");
        sqlx::query("delete from message_containers where message_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        for container in &message.containers {
            sqlx::query("insert into provider_containers(account_id,provider_id,name,kind) values($1,$2,$3,$4) on conflict(account_id,provider_id) do update set name=excluded.name,kind=excluded.kind")
                .bind(account_id).bind(&container.id).bind(&container.name).bind(&container.kind).execute(&mut *tx).await?;
            sqlx::query("insert into message_containers(message_id,account_id,provider_id) values($1,$2,$3) on conflict do nothing").bind(id).bind(account_id).bind(&container.id).execute(&mut *tx).await?;
        }
        let changed = existing.is_none_or(|r| {
            r.get::<String, _>("subject") != message.subject
                || r.get::<String, _>("text_body") != message.text_body
        });
        tx.commit().await?;
        Ok((id, changed))
    }

    pub async fn tombstone_messages(&self, account_id: Uuid, ids: &[String]) -> Result<()> {
        if !ids.is_empty() {
            sqlx::query("update messages set tombstone=true,deleted=true,updated_at=now() where account_id=$1 and provider_message_id=any($2)").bind(account_id).bind(ids).execute(&self.0).await?;
        }
        Ok(())
    }

    pub async fn get_provider_message_reference(&self, id: Uuid) -> Result<Option<(String, Uuid)>> {
        Ok(
            sqlx::query("select provider_message_id,account_id from messages where id=$1")
                .bind(id)
                .fetch_optional(&self.0)
                .await?
                .map(|r| (r.get("provider_message_id"), r.get("account_id"))),
        )
    }

    pub async fn get_analysis_message(&self, id: Uuid) -> Result<Option<Value>> {
        Ok(sqlx::query("select id,subject,from_addresses,to_addresses,cc_addresses,sent_at,received_at,text_body from messages where id=$1 and not tombstone").bind(id).fetch_optional(&self.0).await?.map(|r|json!({"id":r.get::<Uuid,_>("id"),"subject":r.get::<String,_>("subject"),"from":r.get::<Value,_>("from_addresses"),"to":r.get::<Value,_>("to_addresses"),"cc":r.get::<Value,_>("cc_addresses"),"sentAt":r.get::<Option<DateTime<Utc>>,_>("sent_at"),"receivedAt":r.get::<DateTime<Utc>,_>("received_at"),"textBody":r.get::<String,_>("text_body")})))
    }

    pub async fn save_classification_failure(&self, id: Uuid, error: &str) -> Result<()> {
        sqlx::query("insert into classification_failures(message_id,last_error) values($1,$2) on conflict(message_id) do update set attempts=classification_failures.attempts+1,last_error=excluded.last_error,updated_at=now()")
            .bind(id).bind(error.chars().take(2000).collect::<String>()).execute(&self.0).await?;
        Ok(())
    }

    pub async fn save_embedding(
        &self,
        id: Uuid,
        embedding: &[f64],
        model: &str,
        hash: &str,
    ) -> Result<()> {
        sqlx::query("insert into embeddings(message_id,embedding,model,content_hash) values($1,$2::vector,$3,$4) on conflict(message_id) do update set embedding=excluded.embedding,model=excluded.model,content_hash=excluded.content_hash,created_at=now()")
            .bind(id).bind(serde_json::to_string(embedding)?).bind(model).bind(hash).execute(&self.0).await?;
        Ok(())
    }

    pub async fn newest_unclassified(&self, limit: i64, email: Option<&str>) -> Result<Vec<Uuid>> {
        Ok(sqlx::query("select m.id from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id where c.message_id is null and not m.tombstone and m.direction='inbound' and ($2::text is null or lower(a.email)=lower($2)) order by m.received_at desc limit $1")
            .bind(limit).bind(email).fetch_all(&self.0).await?.iter().map(|r|r.get("id")).collect())
    }

    pub async fn newest_inbound(&self, limit: i64, email: Option<&str>) -> Result<Vec<Uuid>> {
        Ok(sqlx::query("select m.id from messages m join accounts a on a.id=m.account_id where not m.tombstone and m.direction='inbound' and ($2::text is null or lower(a.email)=lower($2)) order by m.received_at desc,m.id desc limit $1")
            .bind(limit).bind(email).fetch_all(&self.0).await?.iter().map(|r|r.get("id")).collect())
    }

    pub async fn unembedded(&self, limit: i64, after_id: Option<Uuid>) -> Result<Vec<Uuid>> {
        Ok(sqlx::query("select m.id from messages m left join embeddings e on e.message_id=m.id where e.message_id is null and not m.tombstone and ($2::uuid is null or m.id>$2) order by m.id limit $1")
            .bind(limit).bind(after_id).fetch_all(&self.0).await?.iter().map(|r|r.get("id")).collect())
    }
}
