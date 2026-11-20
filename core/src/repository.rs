use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

#[derive(Clone)]
pub struct Repository(pub PgPool);

pub struct ReplicaInventory {
    pub messages: Vec<Value>,
    pub accounts: Vec<Value>,
}

pub fn replica_fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub view: Option<String>,
    pub account_id: Option<Uuid>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadActionInput {
    pub action: String,
    pub view: String,
    pub account_id: Option<Uuid>,
    pub undoable: bool,
}

fn message_view_condition(view: &str) -> &'static str {
    match view {
        "l1" => {
            "not m.archived and m.direction='inbound' and (coalesce(c.manual_tier,c.model_tier)=1 or c.message_id is null)"
        }
        "l2" => {
            "not m.archived and m.direction='inbound' and coalesce(c.manual_tier,c.model_tier)=2"
        }
        "l3" => {
            "not m.archived and m.direction='inbound' and coalesce(c.manual_tier,c.model_tier)=3"
        }
        "unclassified" => "not m.archived and m.direction='inbound' and c.message_id is null",
        "sent" => "m.direction='outbound' and not m.deleted",
        _ => "true",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    received_at: Option<String>,
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchInput {
    pub q: String,
    pub account_id: Option<Uuid>,
    pub tier: Option<i32>,
    pub after: Option<DateTime<Utc>>,
    pub before: Option<DateTime<Utc>>,
    pub has_attachment: Option<bool>,
    pub limit: Option<i64>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Address {
    #[serde(default)]
    pub name: String,
    pub address: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DraftInput {
    pub id: Option<Uuid>,
    pub account_id: Uuid,
    #[serde(default)]
    pub to: Vec<Address>,
    #[serde(default)]
    pub cc: Vec<Address>,
    #[serde(default)]
    pub bcc: Vec<Address>,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    pub reply_to_message_id: Option<Uuid>,
    pub forward_of_message_id: Option<Uuid>,
}

const SELECT: &str = "m.id, m.thread_id, m.account_id, a.provider::text, a.email account_email, a.display_name account_display_name,
 m.subject, m.from_addresses, m.snippet, m.received_at, m.read, m.flagged, m.direction::text, m.attachments,
 c.model_tier, c.manual_tier, c.reasoning, c.summary, c.plain_text, c.model classification_model,
 exists(select 1 from mutation_outbox o where o.message_id=m.id and o.status in ('pending','processing')) sync_pending";

fn metadata(deleted: bool) -> String {
    format!("cross join lateral (
      select count(*)::int message_count, count(*) filter (where not tm.read)::int unread_count,
        coalesce((select jsonb_agg(person order by person->>'address') from (
          select distinct on (lower(person->>'address')) person
          from messages pm cross join lateral jsonb_array_elements(pm.from_addresses) person
          where pm.thread_id=page.thread_id and not pm.tombstone and pm.deleted={deleted}
          order by lower(person->>'address'), pm.received_at desc, pm.id desc
        ) senders), '[]'::jsonb) participants
      from messages tm where tm.thread_id=page.thread_id and not tm.tombstone and tm.deleted={deleted}
    ) metadata")
}

pub fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn date(row: &PgRow, name: &str) -> Option<String> {
    row.get::<Option<DateTime<Utc>>, _>(name).map(timestamp)
}

fn summary(row: &PgRow) -> Value {
    let manual = row
        .get::<Option<String>, _>("classification_model")
        .as_deref()
        == Some("manual");
    let attachments: Value = row.get("attachments");
    let model_tier: Option<i32> = row.get("model_tier");
    json!({
        "id": row.get::<Uuid,_>("id"), "threadId": row.get::<Uuid,_>("thread_id"),
        "account": {"id":row.get::<Uuid,_>("account_id"), "provider":row.get::<String,_>("provider"),
            "email":row.get::<String,_>("account_email"), "displayName":row.get::<String,_>("account_display_name")},
        "subject":row.get::<String,_>("subject"), "from":row.get::<Value,_>("from_addresses"),
        "snippet":row.get::<String,_>("snippet"), "receivedAt":date(row,"received_at"),
        "read":row.get::<bool,_>("read"), "flagged":row.get::<bool,_>("flagged"),
        "direction":row.get::<String,_>("direction"), "tier":row.get::<Option<i32>,_>("manual_tier").or(model_tier),
        "modelTier":if manual {None} else {model_tier},
        "reasoning":if manual {None} else {row.get::<Option<String>,_>("reasoning")},
        "aiSummary":row.get::<Option<String>,_>("summary"), "attachmentCount":attachments.as_array().map_or(0,Vec::len),
        "syncPending":row.get::<bool,_>("sync_pending")
    })
}

fn detail(row: &PgRow) -> Value {
    let mut value = summary(row);
    for (key, column) in [
        ("to", "to_addresses"),
        ("cc", "cc_addresses"),
        ("bcc", "bcc_addresses"),
        ("attachments", "attachments"),
    ] {
        value[key] = row.get(column);
    }
    value["sentAt"] = json!(date(row, "sent_at"));
    value["textBody"] = json!(row.get::<String, _>("text_body"));
    for (key, column) in [
        ("htmlBody", "html_body"),
        ("plainText", "plain_text"),
        ("internetMessageId", "internet_message_id"),
    ] {
        value[key] = json!(row.get::<Option<String>, _>(column));
    }
    value
}

fn cached_detail(row: &PgRow, state: bool) -> Value {
    let mut value = detail(row);
    if state {
        value["archived"] = json!(row.get::<bool, _>("archived"));
        value["deleted"] = json!(row.get::<bool, _>("deleted"));
        value["classified"] = json!(row.get::<bool, _>("classified"));
    }
    value
}

fn conversation(row: &PgRow) -> Value {
    let mut value = summary(row);
    let unread: i32 = row.get("unread_count");
    value["read"] = json!(unread == 0);
    value["messageCount"] = json!(row.get::<i32, _>("message_count"));
    value["unreadCount"] = json!(unread);
    value["participants"] = row.get("participants");
    value
}

fn draft(row: &PgRow) -> Value {
    json!({"id":row.get::<Uuid,_>("id"),"accountId":row.get::<Uuid,_>("account_id"),
        "to":row.get::<Value,_>("to_addresses"),"cc":row.get::<Value,_>("cc_addresses"),"bcc":row.get::<Value,_>("bcc_addresses"),
        "subject":row.get::<String,_>("subject"),"body":row.get::<String,_>("body"),
        "replyToMessageId":row.get::<Option<Uuid>,_>("reply_to_message_id"),"forwardOfMessageId":row.get::<Option<Uuid>,_>("forward_of_message_id"),
        "createdAt":date(row,"created_at"),"updatedAt":date(row,"updated_at")})
}

impl Repository {
    pub async fn claim_mutations(&self, limit: i64) -> Result<Vec<Value>> {
        let mut tx = self.0.begin().await?;
        let rows = sqlx::query("select id,account_id,message_id,action,payload from mutation_outbox where status in ('pending','processing') and next_attempt_at<=now() order by created_at for update skip locked limit $1")
            .bind(limit).fetch_all(&mut *tx).await?;
        let ids: Vec<Uuid> = rows.iter().map(|r| r.get("id")).collect();
        if !ids.is_empty() {
            sqlx::query("update mutation_outbox set status='processing',attempts=attempts+1,next_attempt_at=now()+interval '5 minutes' where id=any($1)").bind(&ids).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"accountId":r.get::<Uuid,_>("account_id"),"messageId":r.get::<Option<Uuid>,_>("message_id"),"action":r.get::<String,_>("action"),"payload":r.get::<Value,_>("payload")})).collect())
    }

    pub async fn record_send_attempt(&self, id: Uuid) -> Result<()> {
        let result = sqlx::query("update mutation_outbox set payload=payload || jsonb_build_object('sendAttemptedAt',now()) where id=$1 and action='send' and status='processing' and not (payload ? 'sendAttemptedAt') returning id").bind(id).execute(&self.0).await?;
        if result.rows_affected() != 1 {
            bail!("This send has already been attempted; automatic resend blocked");
        }
        Ok(())
    }

    pub async fn complete_mutation(&self, id: Uuid) -> Result<()> {
        sqlx::query("update mutation_outbox set status='complete',completed_at=now(),last_error=null where id=$1").bind(id).execute(&self.0).await?;
        Ok(())
    }

    pub async fn fail_mutation(&self, id: Uuid, error: &str) -> Result<()> {
        sqlx::query("with failed_mutation as (
          update mutation_outbox set status=case when attempts>=12 or payload ? 'sendAttemptedAt' then 'failed'::mutation_status else 'pending'::mutation_status end,
          next_attempt_at=now() + (least(3600,power(2,attempts)::int) * interval '1 second'),
          last_error=case when payload ? 'sendAttemptedAt' then 'Delivery may have succeeded. Automatic resend blocked; check Sent before retrying. ' || $2 else $2 end
          where id=$1 and status in ('pending','processing') returning action,status,payload)
          insert into drafts(id,account_id,to_addresses,cc_addresses,bcc_addresses,subject,body,reply_to_message_id,forward_of_message_id,created_at,updated_at)
          select (draft->>'id')::uuid,(draft->>'accountId')::uuid,draft->'to',draft->'cc',draft->'bcc',draft->>'subject',draft->>'body',
          (select id from messages where id=(draft->>'replyToMessageId')::uuid),
          (select id from messages where id=(draft->>'forwardOfMessageId')::uuid),(draft->>'createdAt')::timestamptz,now()
          from (select payload->'draft' as draft from failed_mutation where action='send' and status='failed' and not (payload ? 'sendAttemptedAt')) restored on conflict(id) do nothing")
          .bind(id).bind(error.chars().take(2000).collect::<String>()).execute(&self.0).await?;
        Ok(())
    }

    pub async fn save_classification(&self, id: Uuid, input: Classification<'_>) -> Result<()> {
        let mut tx = self.0.begin().await?;
        sqlx::query("insert into classifications(message_id,model_tier,reasoning,plain_text,model,prompt_version,summary,classified_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,now(),now()) on conflict(message_id) do update set model_tier=excluded.model_tier,reasoning=excluded.reasoning,summary=excluded.summary,plain_text=excluded.plain_text,model=excluded.model,prompt_version=excluded.prompt_version,classified_at=now(),updated_at=now()")
            .bind(id).bind(input.tier).bind(input.reasoning).bind(input.plain_text.trim()).bind(input.model).bind(input.prompt_version).bind(input.summary.trim()).execute(&mut *tx).await?;
        sqlx::query("delete from classification_failures where message_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn heartbeat(&self, name: &str, metadata: Value) -> Result<()> {
        sqlx::query("insert into worker_state(name,heartbeat_at,metadata) values($1,now(),$2) on conflict(name) do update set heartbeat_at=now(),metadata=excluded.metadata").bind(name).bind(metadata).execute(&self.0).await?;
        Ok(())
    }

    pub async fn finish_sync(
        &self,
        id: Uuid,
        cursor: Option<&str>,
        backfill_complete: bool,
    ) -> Result<()> {
        let mut tx = self.0.begin().await?;
        sqlx::query("insert into sync_cursors(account_id,cursor,backfill_complete,last_successful_at,updated_at) values($1,$2,$3,now(),now()) on conflict(account_id) do update set cursor=excluded.cursor,backfill_complete=excluded.backfill_complete,last_successful_at=now(),updated_at=now()")
            .bind(id).bind(cursor).bind(backfill_complete).execute(&mut *tx).await?;
        sqlx::query("update accounts set status='active',last_synced_at=now(),last_error=null,updated_at=now() where id=$1").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn fail_sync(&self, id: Uuid, error: &str, needs_reauth: bool) -> Result<()> {
        sqlx::query("update accounts set status=$2::text::account_status,last_error=$3,updated_at=now() where id=$1").bind(id).bind(if needs_reauth {"needs_reauth"} else {"error"}).bind(error.chars().take(2000).collect::<String>()).execute(&self.0).await?;
        Ok(())
    }
    pub async fn list_accounts(&self) -> Result<Value> {
        let rows = sqlx::query("select id,provider::text,email,display_name,status::text,last_synced_at from accounts order by created_at").fetch_all(&self.0).await?;
        Ok(json!(
            rows.iter()
                .map(
                    |r| json!({"id":r.get::<Uuid,_>("id"), "provider":r.get::<String,_>("provider"),
            "email":r.get::<String,_>("email"), "displayName":r.get::<String,_>("display_name"),
            "status":r.get::<String,_>("status"), "lastSyncedAt":date(r,"last_synced_at")})
                )
                .collect::<Vec<_>>()
        ))
    }

    pub async fn list_messages(&self, input: ListInput) -> Result<Value> {
        let view = input.view.as_deref().unwrap_or("l1");
        let limit = input.limit.unwrap_or(50);
        if !(1..=100).contains(&limit)
            || !["l1", "l2", "l3", "unclassified", "all", "sent", "trash"].contains(&view)
        {
            bail!("Invalid request");
        }
        let condition = message_view_condition(view);
        let cursor: Option<Value> = input
            .cursor
            .map(|s| -> Result<_> { Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(s)?)?) })
            .transpose()?;
        let received: Option<DateTime<Utc>> = cursor
            .as_ref()
            .map(|v| {
                v["receivedAt"]
                    .as_str()
                    .context("Invalid cursor")?
                    .parse()
                    .map_err(anyhow::Error::from)
            })
            .transpose()?;
        let cursor_id: Option<Uuid> = cursor
            .as_ref()
            .map(|v| {
                v["id"]
                    .as_str()
                    .context("Invalid cursor")?
                    .parse()
                    .map_err(anyhow::Error::from)
            })
            .transpose()?;
        let deleted = view == "trash";
        let sql = format!("with conversations as (select {SELECT},row_number() over(partition by m.thread_id order by m.received_at desc,m.id desc) thread_rank
          from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id
          where not m.tombstone and m.deleted={deleted} and {condition} and ($1::uuid is null or m.account_id=$1)),
          page as (select * from conversations where thread_rank=1 and ($2::timestamptz is null or (received_at,id)<($2,$3::uuid)) order by received_at desc,id desc limit $4)
          select page.*,metadata.* from page {} order by received_at desc,id desc",metadata(deleted));
        let mut rows = sqlx::query(&sql)
            .bind(input.account_id)
            .bind(received)
            .bind(cursor_id)
            .bind(limit + 1)
            .fetch_all(&self.0)
            .await?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last().map(|r| {
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&Cursor {
                        received_at: date(r, "received_at"),
                        id: r.get("id"),
                    })
                    .expect("cursor serialization"),
                )
            })
        } else {
            None
        };
        Ok(json!({"messages":rows.iter().map(conversation).collect::<Vec<_>>(),"nextCursor":next}))
    }

    pub async fn replica_inventory(
        &self,
        ids: Option<&[Uuid]>,
        bodies: bool,
    ) -> Result<ReplicaInventory> {
        let fits = "octet_length(m.text_body)+coalesce(octet_length(m.html_body),0)+coalesce(octet_length(c.plain_text),0)<=262144";
        let include = if bodies { fits } else { "false" };
        let selection = SELECT.replace(
            "c.plain_text",
            &format!("case when {include} then c.plain_text end plain_text"),
        );
        let query = format!("select {selection},m.archived,m.deleted,c.message_id is not null classified,m.to_addresses,m.cc_addresses,m.bcc_addresses,m.sent_at,m.internet_message_id,
          case when {include} then m.text_body else '' end text_body,
          case when {include} then m.html_body end html_body,({include}) body_available,
          encode(sha256(convert_to(jsonb_build_array(m.text_body,m.html_body,c.plain_text)::text,'UTF8')),'hex') body_version,
          m.received_at sort_received_at
          from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id
          where not m.tombstone and ($1::uuid[] is null or m.id=any($1)) order by m.id");
        let mut tx = self.0.begin().await?;
        sqlx::query("set transaction isolation level repeatable read read only")
            .execute(&mut *tx)
            .await?;
        let rows = sqlx::query(&query).bind(ids).fetch_all(&mut *tx).await?;
        let accounts = sqlx::query("select id,provider::text,email,display_name,status::text,last_synced_at from accounts order by created_at").fetch_all(&mut *tx).await?.iter().map(|row| json!({
            "id":row.get::<Uuid,_>("id"),"provider":row.get::<String,_>("provider"),"email":row.get::<String,_>("email"),"displayName":row.get::<String,_>("display_name"),"status":row.get::<String,_>("status"),"lastSyncedAt":date(row,"last_synced_at")
        })).collect();
        let messages = rows
            .iter()
            .map(|row| {
                let mut value = cached_detail(row, true);
                value["bodyVersion"] = json!(row.get::<String, _>("body_version"));
                value["bodyAvailable"] = json!(row.get::<bool, _>("body_available"));
                value["sortReceivedAt"] = json!(
                    row.get::<DateTime<Utc>, _>("sort_received_at")
                        .to_rfc3339_opts(SecondsFormat::Micros, true)
                );
                value
            })
            .collect();
        tx.commit().await?;
        Ok(ReplicaInventory { messages, accounts })
    }

    pub async fn get_message(&self, id: Uuid) -> Result<Option<Value>> {
        self.get_message_with_state(id, false).await
    }

    pub async fn get_message_with_state(&self, id: Uuid, state: bool) -> Result<Option<Value>> {
        let sql = format!(
            "select {SELECT},m.archived,m.deleted,c.message_id is not null classified,m.to_addresses,m.cc_addresses,m.bcc_addresses,m.sent_at,m.text_body,m.html_body,m.internet_message_id from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id where m.id=$1 and not m.tombstone"
        );
        Ok(sqlx::query(&sql)
            .bind(id)
            .fetch_optional(&self.0)
            .await?
            .as_ref()
            .map(|row| cached_detail(row, state)))
    }

    pub async fn get_thread(&self, id: Uuid, trash: bool) -> Result<Value> {
        self.get_thread_with_state(id, trash, false).await
    }

    pub async fn get_thread_with_state(&self, id: Uuid, trash: bool, state: bool) -> Result<Value> {
        let sql = format!(
            "select {SELECT},m.archived,m.deleted,c.message_id is not null classified,m.to_addresses,m.cc_addresses,m.bcc_addresses,m.sent_at,m.text_body,m.html_body,m.internet_message_id from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id where m.thread_id=$1 and not m.tombstone and m.deleted=$2 order by m.received_at,m.id"
        );
        Ok(json!(
            sqlx::query(&sql)
                .bind(id)
                .bind(trash)
                .fetch_all(&self.0)
                .await?
                .iter()
                .map(|row| cached_detail(row, state))
                .collect::<Vec<_>>()
        ))
    }

    pub async fn mutation_message_ids(&self, id: Uuid) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar("select message_id from mutation_outbox where (id=$1 or payload->>'groupId'=$1::text) and message_id is not null")
            .bind(id).fetch_all(&self.0).await?)
    }

    pub async fn message_states(&self, ids: &[Uuid]) -> Result<Value> {
        let rows = sqlx::query("select m.id,m.thread_id,m.read,m.flagged,m.archived,m.deleted,c.message_id is not null classified,c.model_tier,c.manual_tier,c.model,c.reasoning,exists(select 1 from mutation_outbox o where o.message_id=m.id and o.status in ('pending','processing')) sync_pending from messages m left join classifications c on c.message_id=m.id where m.id=any($1) and not m.tombstone")
            .bind(ids).fetch_all(&self.0).await?;
        Ok(json!(rows.iter().map(|row| {
            let model: Option<i32> = row.get("model_tier");
            let manual: Option<i32> = row.get("manual_tier");
            let manual_only = row.get::<Option<String>, _>("model").as_deref() == Some("manual");
            json!({"id":row.get::<Uuid,_>("id"),"threadId":row.get::<Uuid,_>("thread_id"),"read":row.get::<bool,_>("read"),"flagged":row.get::<bool,_>("flagged"),"archived":row.get::<bool,_>("archived"),"deleted":row.get::<bool,_>("deleted"),"classified":row.get::<bool,_>("classified"),"tier":manual.or(model),"modelTier":if manual_only {None}else{model},"reasoning":row.get::<Option<String>,_>("reasoning"),"syncPending":row.get::<bool,_>("sync_pending")})
        }).collect::<Vec<_>>()))
    }

    pub async fn search(&self, input: &SearchInput, embedding: Option<Vec<f64>>) -> Result<Value> {
        let limit = input.limit.unwrap_or(50);
        if input.q.trim().is_empty()
            || input.q.encode_utf16().count() > 500
            || !(1..=100).contains(&limit)
            || input.tier.is_some_and(|t| !(1..=3).contains(&t))
        {
            bail!("Invalid request");
        }
        let filter = "not m.tombstone and not m.deleted and ($2::uuid is null or m.account_id=$2) and ($3::int is null or coalesce(c.manual_tier,c.model_tier)=$3) and ($4::timestamptz is null or m.received_at >= $4) and ($5::timestamptz is null or m.received_at < $5) and ($6::bool is null or (jsonb_array_length(m.attachments)>0)=$6)";
        let prefix = if embedding.is_some() {
            format!("with lexical as (select m.id,row_number() over(order by ts_rank_cd(m.search_document,websearch_to_tsquery('english',$1)) desc) rank from messages m left join classifications c on c.message_id=m.id where {filter} and m.search_document @@ websearch_to_tsquery('english',$1) limit 200),
            semantic as (select m.id,row_number() over(order by e.embedding <=> $8::vector) rank from messages m join embeddings e on e.message_id=m.id left join classifications c on c.message_id=m.id where {filter} order by e.embedding <=> $8::vector limit 200),
            fused as (select id,sum(score) score from (select id,1.0/(60+rank) score from lexical union all select id,1.0/(60+rank) score from semantic) scores group by id),
            matches as (select {SELECT},f.score search_score from fused f join messages m on m.id=f.id join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id)")
        } else {
            format!(
                "with matches as (select {SELECT},ts_rank_cd(m.search_document,websearch_to_tsquery('english',$1)) search_score from messages m join accounts a on a.id=m.account_id left join classifications c on c.message_id=m.id where {filter} and m.search_document @@ websearch_to_tsquery('english',$1))"
            )
        };
        let sql = format!(
            "{prefix},ranked as (select *,row_number() over(partition by thread_id order by search_score desc,received_at desc,id desc) thread_rank from matches),page as (select * from ranked where thread_rank=1 order by search_score desc,received_at desc,id desc limit $7) select page.*,metadata.* from page {} order by search_score desc,received_at desc,id desc",
            metadata(false)
        );
        let query = sqlx::query(&sql)
            .bind(input.q.trim())
            .bind(input.account_id)
            .bind(input.tier)
            .bind(input.after)
            .bind(input.before)
            .bind(input.has_attachment)
            .bind(limit);
        let query = if let Some(ref embedding) = embedding {
            query.bind(serde_json::to_string(embedding)?)
        } else {
            query
        };
        let rows = query.persistent(false).fetch_all(&self.0).await?;
        Ok(
            json!({"messages":rows.iter().map(conversation).collect::<Vec<_>>(),"mode":if embedding.is_some(){"hybrid"}else{"lexical"}}),
        )
    }

    pub async fn list_drafts(&self) -> Result<Value> {
        Ok(json!(
            sqlx::query("select * from drafts order by updated_at desc")
                .fetch_all(&self.0)
                .await?
                .iter()
                .map(draft)
                .collect::<Vec<_>>()
        ))
    }

    pub async fn get_draft(&self, id: Uuid) -> Result<Option<Value>> {
        Ok(sqlx::query("select * from drafts where id=$1")
            .bind(id)
            .fetch_optional(&self.0)
            .await?
            .as_ref()
            .map(draft))
    }

    pub async fn save_draft(&self, input: DraftInput) -> Result<Value> {
        if input.subject.encode_utf16().count() > 998
            || input.body.encode_utf16().count() > 2_000_000
            || input
                .to
                .iter()
                .chain(&input.cc)
                .chain(&input.bcc)
                .any(|a| !a.address.contains('@'))
        {
            bail!("Invalid request");
        }
        let row = if let Some(id) = input.id {
            sqlx::query("update drafts set account_id=$1,to_addresses=$2,cc_addresses=$3,bcc_addresses=$4,subject=$5,body=$6,reply_to_message_id=$7,forward_of_message_id=$8,updated_at=now() where id=$9 returning *")
                .bind(input.account_id).bind(json!(input.to)).bind(json!(input.cc)).bind(json!(input.bcc)).bind(input.subject).bind(input.body).bind(input.reply_to_message_id).bind(input.forward_of_message_id).bind(id).fetch_optional(&self.0).await?.context("Draft not found")?
        } else {
            sqlx::query("insert into drafts(account_id,to_addresses,cc_addresses,bcc_addresses,subject,body,reply_to_message_id,forward_of_message_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *")
                .bind(input.account_id).bind(json!(input.to)).bind(json!(input.cc)).bind(json!(input.bcc)).bind(input.subject).bind(input.body).bind(input.reply_to_message_id).bind(input.forward_of_message_id).fetch_one(&self.0).await?
        };
        Ok(draft(&row))
    }

    pub async fn delete_draft(&self, id: Uuid) -> Result<()> {
        sqlx::query("delete from drafts where id=$1")
            .bind(id)
            .execute(&self.0)
            .await?;
        Ok(())
    }

    pub async fn set_tier(&self, id: Uuid, tier: Option<i32>) -> Result<()> {
        if tier.is_some_and(|t| !(1..=3).contains(&t)) {
            bail!("Invalid request");
        }
        if let Some(tier) = tier {
            sqlx::query("insert into classifications(message_id,model_tier,manual_tier,reasoning,model,prompt_version) values($1,1,$2,'Manual classification before model result','manual','manual') on conflict(message_id) do update set manual_tier=excluded.manual_tier,updated_at=now()")
                .bind(id).bind(tier).execute(&self.0).await?;
        } else {
            sqlx::query(
                "update classifications set manual_tier=null,updated_at=now() where message_id=$1",
            )
            .bind(id)
            .execute(&self.0)
            .await?;
        }
        Ok(())
    }

    pub async fn enqueue_action(
        &self,
        message_id: Uuid,
        action: &str,
        undo: Option<DateTime<Utc>>,
    ) -> Result<Uuid> {
        let update = match action {
            "mark_read" => "read=true",
            "mark_unread" => "read=false",
            "flag" => "flagged=true",
            "unflag" => "flagged=false",
            "archive" => "archived=true",
            "delete" => "deleted=true",
            _ => bail!("Invalid request"),
        };
        let mut tx = self.0.begin().await?;
        let message =
            sqlx::query("select account_id,archived,deleted from messages where id=$1 for update")
                .bind(message_id)
                .fetch_optional(&mut *tx)
                .await?
                .context("Message not found")?;
        if sqlx::query("select id from mutation_outbox where message_id=$1 and action=$2 and status='pending' and (payload->>'undoUntil')::timestamptz>clock_timestamp()")
            .bind(message_id).bind(action).fetch_optional(&mut *tx).await?.is_some() {bail!("This action is already pending");}
        let id = Uuid::new_v4();
        let payload = if let Some(until) = undo {
            json!({"undoUntil":timestamp(until),"previous":{"archived":message.get::<bool,_>("archived"),"deleted":message.get::<bool,_>("deleted")}})
        } else {
            json!({})
        };
        sqlx::query("insert into mutation_outbox(id,idempotency_key,account_id,message_id,action,payload,next_attempt_at) values($1,$2,$3,$4,$5,$6,coalesce($7,now()))")
            .bind(id).bind(id.to_string()).bind(message.get::<Uuid,_>("account_id")).bind(message_id).bind(action).bind(payload).bind(undo).execute(&mut *tx).await?;
        sqlx::query(&format!(
            "update messages set {update},updated_at=now() where id=$1"
        ))
        .bind(message_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn enqueue_thread_action(
        &self,
        thread_id: Uuid,
        input: &ThreadActionInput,
        undo: Option<DateTime<Utc>>,
    ) -> Result<Uuid> {
        let field = match input.action.as_str() {
            "archive" => "archived",
            "delete" => "deleted",
            _ => bail!("Invalid request"),
        };
        if !["l1", "l2", "l3", "unclassified", "all", "sent", "trash"]
            .contains(&input.view.as_str())
        {
            bail!("Invalid request");
        }
        let mut tx = self.0.begin().await?;
        let rows = sqlx::query(&format!("select m.id,m.account_id,m.archived,m.deleted from messages m left join classifications c on c.message_id=m.id where m.thread_id=$1 and not m.tombstone and m.deleted={} and {} and ($2::uuid is null or m.account_id=$2) order by m.id for update of m", input.view == "trash", message_view_condition(&input.view)))
            .bind(thread_id).bind(input.account_id).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            bail!("Message not found");
        }
        let group_id = Uuid::new_v4();
        let mut inserted = 0;
        for row in rows {
            let message_id: Uuid = row.get("id");
            if sqlx::query("select id from mutation_outbox where message_id=$1 and action=$2 and status='pending'")
                .bind(message_id).bind(&input.action).fetch_optional(&mut *tx).await?.is_some() {
                continue;
            }
            let id = if inserted == 0 {
                group_id
            } else {
                Uuid::new_v4()
            };
            let payload = json!({"groupId":group_id,"undoUntil":undo.map(timestamp),"previous":{"archived":row.get::<bool,_>("archived"),"deleted":row.get::<bool,_>("deleted")}});
            sqlx::query("insert into mutation_outbox(id,idempotency_key,account_id,message_id,action,payload,next_attempt_at) values($1,$2,$3,$4,$5,$6,coalesce($7,now()))")
                .bind(id).bind(id.to_string()).bind(row.get::<Uuid,_>("account_id")).bind(message_id).bind(&input.action).bind(payload).bind(undo).execute(&mut *tx).await?;
            sqlx::query(&format!(
                "update messages set {field}=true,updated_at=now() where id=$1"
            ))
            .bind(message_id)
            .execute(&mut *tx)
            .await?;
            inserted += 1;
        }
        if inserted == 0 {
            bail!("This action is already pending");
        }
        tx.commit().await?;
        Ok(group_id)
    }

    pub async fn enqueue_send(
        &self,
        draft_id: Uuid,
        attachments: Value,
        undo: Option<DateTime<Utc>>,
    ) -> Result<Uuid> {
        let mut tx = self.0.begin().await?;
        let row = sqlx::query("select * from drafts where id=$1 for update")
            .bind(draft_id)
            .fetch_optional(&mut *tx)
            .await?
            .context("Draft not found")?;
        let id = Uuid::new_v4();
        sqlx::query("insert into mutation_outbox(id,idempotency_key,account_id,action,payload,next_attempt_at) values($1,$2,$3,'send',$4,coalesce($5,now()))")
            .bind(id).bind(id.to_string()).bind(row.get::<Uuid,_>("account_id"))
            .bind(json!({"draft":draft(&row),"attachments":attachments,"undoUntil":undo.map(timestamp)})).bind(undo).execute(&mut *tx).await?;
        sqlx::query("delete from drafts where id=$1")
            .bind(draft_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(id)
    }

    pub async fn undo(&self, id: Uuid) -> Result<Value> {
        let mut tx = self.0.begin().await?;
        let rows = sqlx::query("select * from mutation_outbox where (id=$1 or payload->>'groupId'=$1::text) and status='pending' and (payload->>'undoUntil')::timestamptz>clock_timestamp() for update").bind(id).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            bail!("Undo window expired");
        }
        let mut result = Value::Null;
        for row in rows {
            let action: String = row.get("action");
            let payload: Value = row.get("payload");
            if action == "send" {
                let input: DraftInput = serde_json::from_value(payload["draft"].clone())?;
                sqlx::query("insert into drafts(id,account_id,to_addresses,cc_addresses,bcc_addresses,subject,body,reply_to_message_id,forward_of_message_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)")
                .bind(input.id).bind(input.account_id).bind(json!(input.to)).bind(json!(input.cc)).bind(json!(input.bcc)).bind(input.subject).bind(input.body).bind(input.reply_to_message_id).bind(input.forward_of_message_id).execute(&mut *tx).await?;
                result = payload["draft"].clone();
            } else if action == "archive" || action == "delete" {
                let field = if action == "archive" {
                    "archived"
                } else {
                    "deleted"
                };
                sqlx::query(&format!(
                    "update messages set {field}=$2,updated_at=now() where id=$1"
                ))
                .bind(row.get::<Option<Uuid>, _>("message_id"))
                .bind(payload["previous"][field].as_bool())
                .execute(&mut *tx)
                .await?;
            } else {
                bail!("Undo window expired");
            }
            sqlx::query("delete from mutation_outbox where id=$1")
                .bind(row.get::<Uuid, _>("id"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(result)
    }

    pub async fn health(&self) -> Result<Value> {
        let row = sqlx::query("select (select max(heartbeat_at) from worker_state) worker_heartbeat,(select count(*) from mutation_outbox where status='failed') failed_mutations,(select count(*) from classification_failures) classification_failures,count(*) accounts,count(*) filter(where status='needs_reauth') needs_reauth,min(last_synced_at) oldest_successful_sync_at,count(*) filter(where last_synced_at is null or last_synced_at<now()-interval '3 minutes') stale from accounts").fetch_one(&self.0).await?;
        let heartbeat: Option<DateTime<Utc>> = row.get("worker_heartbeat");
        let failed: i64 = row.get("failed_mutations");
        let needs: i64 = row.get("needs_reauth");
        let stale: i64 = row.get("stale");
        let fresh = needs == 0 && stale == 0;
        let degraded = heartbeat.is_none_or(|h| (Utc::now() - h).num_milliseconds() > 180_000)
            || failed > 0
            || !fresh;
        Ok(
            json!({"status":if degraded{"degraded"}else{"ok"},"database":true,"workerHeartbeat":heartbeat.map(timestamp),"failedMutations":failed,"classificationFailures":row.get::<i64,_>("classification_failures"),"sync":{"accounts":row.get::<i64,_>("accounts"),"needsReauth":needs,"oldestSuccessfulSyncAt":date(&row,"oldest_successful_sync_at"),"stale":stale,"fresh":fresh}}),
        )
    }
}

pub struct Classification<'a> {
    pub tier: i32,
    pub reasoning: &'a str,
    pub summary: &'a str,
    pub plain_text: &'a str,
    pub model: &'a str,
    pub prompt_version: &'a str,
}
