use anyhow::Result;
use chrono::{Duration, TimeZone, Utc};
use sent_core::db::Uuid;
use sent_core::{
    db,
    repository::{
        Classification, DraftInput, ListInput, Repository, SearchInput, ThreadActionInput,
    },
};
use serde_json::{Value, json};
use sqlx::Row;

struct Fixture {
    repo: Repository,
    owner: Uuid,
    other: Uuid,
}

impl Fixture {
    async fn reset(&self) -> Result<()> {
        sqlx::raw_sql("delete from accounts; delete from worker_state")
            .execute(&self.repo.0)
            .await?;
        for id in [self.owner, self.other] {
            sqlx::query("insert into accounts(id,provider,email,encrypted_credentials) values(?1,'microsoft',?2,'test')").bind(id).bind(format!("{id}@example.test")).execute(&self.repo.0).await?;
        }
        Ok(())
    }

    async fn message(&self, thread: &str, hour: i64, options: Value) -> Result<Uuid> {
        let owner = options["owner"]
            .as_str()
            .map(str::parse)
            .transpose()?
            .unwrap_or(self.owner);
        let received = Utc.with_ymd_and_hms(2026, 9, 22, 0, 0, 0).unwrap() + Duration::hours(hour);
        let id = Uuid::new_v4();
        let row=sqlx::query("insert into threads(account_id,provider_thread_id,subject,last_message_at,id) values(?1,?2,?2,?3,?4) on conflict(account_id,provider_thread_id) do update set last_message_at=max(threads.last_message_at,excluded.last_message_at) returning id").bind(owner).bind(thread).bind(sent_core::db::timestamp(received)).bind(Uuid::new_v4()).fetch_one(&self.repo.0).await?;
        sqlx::query("insert into messages(id,account_id,thread_id,provider_message_id,subject,from_addresses,sent_at,received_at,snippet,text_body,direction,read,archived,deleted,tombstone) values(?1,?2,?3,?4,?5,?6,?7,?7,'Test',?8,?9,?10,?11,?12,?13)")
            .bind(id).bind(owner).bind(row.get::<Uuid,_>("id")).bind(id.to_string()).bind(options["subject"].as_str().unwrap_or(thread))
            .bind(options.get("from").cloned().unwrap_or(json!([{"name":"Sender","address":"sender@example.com"}])))
            .bind(sent_core::db::timestamp(received)).bind(options["textBody"].as_str().unwrap_or("Test"))
            .bind(options["direction"].as_str().unwrap_or("inbound")).bind(options["read"].as_bool().unwrap_or(true))
            .bind(options["archived"].as_bool().unwrap_or(false)).bind(options["deleted"].as_bool().unwrap_or(false)).bind(options["tombstone"].as_bool().unwrap_or(false)).execute(&self.repo.0).await?;
        Ok(id)
    }

    async fn list(
        &self,
        view: &str,
        limit: i64,
        cursor: Option<&str>,
        owner: Option<Uuid>,
    ) -> Result<Value> {
        self.repo
            .list_messages(ListInput {
                view: Some(view.into()),
                account_id: owner,
                cursor: cursor.map(str::to_owned),
                limit: Some(limit),
            })
            .await
    }

    async fn search(
        &self,
        q: &str,
        limit: i64,
        owner: Option<Uuid>,
        tier: Option<i32>,
    ) -> Result<Value> {
        self.repo
            .search(
                &SearchInput {
                    q: q.into(),
                    account_id: owner,
                    tier,
                    after: None,
                    before: None,
                    has_attachment: None,
                    limit: Some(limit),
                },
                None,
            )
            .await
    }

    async fn draft(&self, reply: Option<Uuid>, forward: Option<Uuid>) -> Result<Value> {
        self.repo.save_draft(serde_json::from_value::<DraftInput>(json!({"accountId":self.owner,"to":[{"name":"Recipient","address":"to@example.com"}],"cc":[{"name":"CC","address":"cc@example.com"}],"bcc":[{"name":"BCC","address":"bcc@example.com"}],"subject":"Recovered reply","body":"Do not lose this reply","replyToMessageId":reply,"forwardOfMessageId":forward}))?).await
    }

    async fn queued_draft(&self) -> Result<(Uuid, Value)> {
        let reply = self.message("reply", 8, json!({})).await?;
        let forward = self.message("forward", 9, json!({})).await?;
        let draft = self.draft(Some(reply), Some(forward)).await?;
        let id = self
            .repo
            .enqueue_send(uuid(&draft["id"]), json!([]), None)
            .await?;
        assert!(self.repo.get_draft(uuid(&draft["id"])).await?.is_none());
        Ok((id, draft))
    }

    async fn attempts(&self, id: Uuid, attempts: i32) -> Result<()> {
        sqlx::query("update mutation_outbox set attempts=?2,status='processing' where id=?1")
            .bind(id)
            .bind(attempts)
            .execute(&self.repo.0)
            .await?;
        Ok(())
    }
    async fn status(&self, id: Uuid) -> Result<String> {
        Ok(
            sqlx::query("select status from mutation_outbox where id=?1")
                .bind(id)
                .fetch_one(&self.repo.0)
                .await?
                .get("status"),
        )
    }
    async fn state(&self, id: Uuid) -> Result<Value> {
        Ok(sqlx::query_scalar("select json_object('archived',json(case when archived then 'true' else 'false' end),'deleted',json(case when deleted then 'true' else 'false' end)) from messages where id=?1")
            .bind(id).fetch_one(&self.repo.0).await?)
    }
}

fn uuid(value: &Value) -> Uuid {
    value.as_str().unwrap().parse().unwrap()
}
fn ids(value: &Value) -> Vec<Uuid> {
    value["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| uuid(&v["id"]))
        .collect()
}

#[tokio::test]
async fn mail_views_and_send_checkpoints() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("sent.sqlite");
    let pool = db::pool(path.to_str().unwrap(), true).await?;
    let config = sent_core::config::Config::from_env()?;
    db::migrate(&pool, &config.migrations_path).await?;
    let f = Fixture {
        repo: Repository(pool),
        owner: Uuid::new_v4(),
        other: Uuid::new_v4(),
    };

    f.reset().await?;
    let unsorted = f.message("unsorted", 1, json!({})).await?;
    let mut expected = vec![unsorted];
    for tier in 1..=3 {
        let id = f
            .message(&format!("tier-{tier}"), tier + 1, json!({}))
            .await?;
        f.repo
            .save_classification(id, classification(tier as i32, "summary"))
            .await?;
        expected.push(id);
    }
    f.message("archived", 8, json!({"archived":true})).await?;
    f.message("outbound", 9, json!({"direction":"outbound"}))
        .await?;
    f.message("deleted", 10, json!({"deleted":true})).await?;
    f.message("tombstone", 11, json!({"tombstone":true}))
        .await?;
    expected.reverse();
    assert_eq!(ids(&f.list("inbox", 50, None, None).await?), expected);
    assert_eq!(
        ids(&f.repo.list_messages(ListInput::default()).await?),
        expected
    );
    assert_eq!(ids(&f.list("all", 50, None, None).await?).len(), 6);
    assert!(f.list("invalid", 50, None, None).await.is_err());
    let thread = uuid(&f.repo.get_message(unsorted).await?.unwrap()["threadId"]);
    let extra = f.message("unsorted", 12, json!({})).await?;
    f.repo
        .save_classification(extra, classification(2, "summary"))
        .await?;
    for action in ["archive", "delete"] {
        let receipt = f
            .repo
            .enqueue_thread_action(
                thread,
                &ThreadActionInput {
                    action: action.into(),
                    view: "inbox".into(),
                    account_id: Some(f.owner),
                    undoable: true,
                },
                Some(Utc::now() + Duration::seconds(5)),
            )
            .await?;
        assert_eq!(f.repo.mutation_message_ids(receipt).await?.len(), 2);
        assert_eq!(ids(&f.list("inbox", 50, None, None).await?).len(), 3);
        f.repo.undo(receipt).await?;
        assert_eq!(ids(&f.list("inbox", 50, None, None).await?).len(), 4);
    }
    f.reset().await?;
    assert!(ids(&f.list("inbox", 50, None, None).await?).is_empty());

    for action in ["archive", "delete"] {
        f.reset().await?;
        let mut members = Vec::new();
        for hour in 8..11 {
            members.push(f.message("group", hour, json!({})).await?);
        }
        let archived = f.message("group", 11, json!({"archived":true})).await?;
        let deleted = f.message("group", 12, json!({"deleted":true})).await?;
        let tier3 = f.message("group", 13, json!({})).await?;
        f.repo.set_tier(tier3, Some(3)).await?;
        f.message("group", 14, json!({"direction":"outbound"}))
            .await?;
        let thread = uuid(&f.repo.get_message(members[0]).await?.unwrap()["threadId"]);
        assert!(
            f.repo
                .get_message(members[0])
                .await?
                .unwrap()
                .get("archived")
                .is_none()
        );
        let cached = f.repo.get_thread_with_state(thread, false, true).await?;
        assert_eq!(cached.as_array().unwrap().len(), 6);
        assert!(
            cached
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["deleted"] == false && item["classified"].is_boolean())
        );
        let input = ThreadActionInput {
            action: action.into(),
            view: "l1".into(),
            account_id: Some(f.owner),
            undoable: true,
        };
        let receipt = f
            .repo
            .enqueue_thread_action(thread, &input, Some(Utc::now() + Duration::seconds(5)))
            .await?;
        let rows = sqlx::query("select payload from mutation_outbox")
            .fetch_all(&f.repo.0)
            .await?;
        assert_eq!(rows.len(), 3);
        let affected = f.repo.mutation_message_ids(receipt).await?;
        assert_eq!(affected.len(), 3);
        let patches = f.repo.message_states(&affected).await?;
        assert_eq!(patches.as_array().unwrap().len(), 3);
        assert!(
            patches
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item[if action == "archive" {
                    "archived"
                } else {
                    "deleted"
                }] == true)
        );
        assert!(
            rows.iter()
                .all(|row| row.get::<Value, _>("payload")["groupId"] == receipt.to_string())
        );
        assert!(f.repo.claim_mutations(50).await?.is_empty());
        assert!(ids(&f.list("l1", 50, None, None).await?).is_empty());
        for (id, column) in [(archived, "archived"), (deleted, "deleted")] {
            let row = sqlx::query(&format!("select {column} from messages where id=?1"))
                .bind(id)
                .fetch_one(&f.repo.0)
                .await?;
            assert!(row.get::<bool, _>(column));
        }
        assert_eq!(
            f.state(tier3).await?,
            json!({"archived":false,"deleted":false})
        );
        f.repo.undo(receipt).await?;
        assert_eq!(ids(&f.list("l1", 50, None, None).await?).len(), 1);
        for member in members {
            let message = f.state(member).await?;
            assert_eq!(message["archived"], false);
            assert_eq!(message["deleted"], false);
        }
        assert!(f.repo.claim_mutations(50).await?.is_empty());
        assert!(f.repo.undo(receipt).await.is_err());
    }
    f.reset().await?;
    let source = f.message("trash-group", 8, json!({"deleted":true})).await?;
    f.message("trash-group", 9, json!({"deleted":true})).await?;
    let thread = uuid(&f.repo.get_message(source).await?.unwrap()["threadId"]);
    let input = ThreadActionInput {
        action: "delete".into(),
        view: "trash".into(),
        account_id: None,
        undoable: true,
    };
    let receipt = f
        .repo
        .enqueue_thread_action(thread, &input, Some(Utc::now() + Duration::seconds(5)))
        .await?;
    assert!(
        f.repo
            .enqueue_thread_action(thread, &input, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("already pending")
    );
    f.repo.undo(receipt).await?;
    assert_eq!(f.state(source).await?["deleted"], true);
    let expired = f
        .repo
        .enqueue_thread_action(thread, &input, Some(Utc::now() - Duration::seconds(1)))
        .await?;
    assert!(f.repo.undo(expired).await.is_err());
    assert!(
        f.repo
            .enqueue_thread_action(Uuid::new_v4(), &input, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("Message not found")
    );

    for action in ["archive", "delete"] {
        f.reset().await?;
        let source = f.message("undo", 8, json!({})).await?;
        let until = Some(Utc::now() + Duration::seconds(5));
        let id = f.repo.enqueue_action(source, action, until).await?;
        assert!(f.repo.claim_mutations(50).await?.is_empty());
        let column = if action == "archive" {
            "archived"
        } else {
            "deleted"
        };
        let sql = format!("select {column} from messages where id=?1");
        assert!(
            sqlx::query(&sql)
                .bind(source)
                .fetch_one(&f.repo.0)
                .await?
                .get::<bool, _>(column)
        );
        assert!(f.repo.enqueue_action(source, action, until).await.is_err());
        f.repo.undo(id).await?;
        assert!(
            !sqlx::query(&sql)
                .bind(source)
                .fetch_one(&f.repo.0)
                .await?
                .get::<bool, _>(column)
        );
        assert!(f.repo.undo(id).await.is_err());
        assert!(f.repo.claim_mutations(50).await?.is_empty());
        let (a, b) = tokio::join!(
            f.repo.enqueue_action(source, action, until),
            f.repo.enqueue_action(source, action, until)
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
        f.repo.undo(a.or(b)?).await?;
    }
    f.reset().await?;
    let archived = f
        .message("already archived", 8, json!({"archived":true}))
        .await?;
    let id = f
        .repo
        .enqueue_action(archived, "archive", Some(Utc::now() + Duration::seconds(5)))
        .await?;
    f.repo.undo(id).await?;
    assert!(
        sqlx::query("select archived from messages where id=?1")
            .bind(archived)
            .fetch_one(&f.repo.0)
            .await?
            .get::<bool, _>("archived")
    );
    let expired = f
        .repo
        .enqueue_action(archived, "delete", Some(Utc::now() - Duration::seconds(1)))
        .await?;
    assert!(f.repo.undo(expired).await.is_err());
    assert_eq!(f.repo.claim_mutations(50).await?[0]["id"], json!(expired));
    assert!(f.repo.undo(expired).await.is_err());

    f.reset().await?;
    let original = f.message("reply", 8, json!({})).await?;
    let draft = f.draft(Some(original), None).await?;
    let draft_id = uuid(&draft["id"]);
    let id = f
        .repo
        .enqueue_send(draft_id, json!([]), Some(Utc::now() + Duration::seconds(5)))
        .await?;
    assert!(f.repo.get_draft(draft_id).await?.is_none());
    assert!(f.repo.claim_mutations(50).await?.is_empty());
    let (a, b) = tokio::join!(f.repo.undo(id), f.repo.undo(id));
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(
        f.repo.get_draft(draft_id).await?.unwrap()["replyToMessageId"],
        json!(original)
    );
    assert!(f.repo.claim_mutations(50).await?.is_empty());

    f.reset().await?;
    f.message("conversation", 8, json!({"read":false})).await?;
    let inbound = f.message("conversation", 10, json!({})).await?;
    for hour in [11, 12] {
        f.message("conversation", hour, json!({"direction":"outbound"}))
            .await?;
    }
    let sent = f
        .message("conversation", 13, json!({"direction":"outbound"}))
        .await?;
    let different = f.message("different", 14, json!({})).await?;
    let other = f
        .message("conversation", 9, json!({"owner":f.other}))
        .await?;
    f.message("deleted", 16, json!({"deleted":true})).await?;
    f.message("archived", 17, json!({"archived":true})).await?;
    f.message("removed", 18, json!({"tombstone":true})).await?;
    let first = f.list("l1", 1, None, None).await?;
    assert_eq!(ids(&first), vec![different]);
    let second = f.list("l1", 1, first["nextCursor"].as_str(), None).await?;
    assert_eq!(ids(&second), vec![inbound]);
    assert_eq!(second["messages"][0]["messageCount"], 5);
    assert_eq!(second["messages"][0]["unreadCount"], 1);
    assert_eq!(second["messages"][0]["read"], false);
    let third = f.list("l1", 1, second["nextCursor"].as_str(), None).await?;
    assert_eq!(ids(&third), vec![other]);
    assert!(third["nextCursor"].is_null());
    assert_eq!(ids(&f.list("sent", 50, None, None).await?), vec![sent]);
    assert_eq!(ids(&f.list("l1", 50, None, Some(f.owner)).await?).len(), 2);
    let thread = uuid(&second["messages"][0]["threadId"]);
    assert_eq!(
        f.repo
            .get_thread(thread, false)
            .await?
            .as_array()
            .unwrap()
            .len(),
        5
    );

    f.reset().await?;
    f.message(
        "offer",
        8,
        json!({"read":false,"from":[{"name":"Maya","address":"maya@example.com"}]}),
    )
    .await?;
    let latest = f
        .message(
            "offer",
            10,
            json!({"from":[{"name":"Maya Chen","address":"MAYA@example.com"}]}),
        )
        .await?;
    f.message(
        "offer",
        11,
        json!({"direction":"outbound","from":[{"name":"Me","address":"me@example.com"}]}),
    )
    .await?;
    f.message("offer", 12, json!({"deleted":true,"read":false}))
        .await?;
    f.message("offer", 13, json!({"tombstone":true,"read":false}))
        .await?;
    let inbox = f.list("l1", 50, None, None).await?;
    assert_eq!(ids(&inbox), vec![latest]);
    assert_eq!(inbox["messages"][0]["messageCount"], 3);
    assert_eq!(inbox["messages"][0]["unreadCount"], 1);
    assert_eq!(
        inbox["messages"][0]["participants"],
        json!([{"name":"Maya Chen","address":"MAYA@example.com"},{"name":"Me","address":"me@example.com"}])
    );
    let trash = f.list("trash", 50, None, None).await?;
    assert_eq!(trash["messages"][0]["messageCount"], 1);
    assert_eq!(trash["messages"][0]["unreadCount"], 1);
    let thread = uuid(&inbox["messages"][0]["threadId"]);
    assert_eq!(
        f.repo
            .get_thread(thread, false)
            .await?
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        f.repo
            .get_thread(thread, true)
            .await?
            .as_array()
            .unwrap()
            .len(),
        1
    );

    f.reset().await?;
    f.message("offer", 8, json!({"read":false})).await?;
    f.message("offer", 9, json!({})).await?;
    let latest = f.message("offer", 10, json!({})).await?;
    f.message(
        "offer",
        11,
        json!({"direction":"outbound","subject":"Accepted","textBody":"Thanks"}),
    )
    .await?;
    f.message("offer", 12, json!({"deleted":true})).await?;
    let other = f.message("offer", 7, json!({"owner":f.other})).await?;
    let second = f.message("another offer", 6, json!({})).await?;
    let results = f.search("offer", 2, None, None).await?;
    assert_eq!(ids(&results), vec![latest, other]);
    assert_eq!(results["messages"][0]["messageCount"], 4);
    assert_eq!(results["messages"][0]["unreadCount"], 1);
    assert_eq!(
        ids(&f.search("offer", 50, None, None).await?),
        vec![latest, other, second]
    );
    assert_eq!(
        ids(&f.search("offer", 50, Some(f.owner), None).await?),
        vec![latest, second]
    );
    f.repo
        .save_classification(second, classification(3, "summary"))
        .await?;
    assert_eq!(
        ids(&f.search("offer", 50, None, Some(3)).await?),
        vec![second]
    );
    assert!(ids(&f.search("no-match", 50, None, None).await?).is_empty());

    f.reset().await?;
    let important = f.message("conversation", 8, json!({})).await?;
    let newsletter = f.message("conversation", 9, json!({})).await?;
    f.repo
        .save_classification(important, classification(1, "summary"))
        .await?;
    f.repo
        .save_classification(newsletter, classification(3, "summary"))
        .await?;
    assert_eq!(ids(&f.list("l1", 50, None, None).await?), vec![important]);
    assert_eq!(ids(&f.list("l3", 50, None, None).await?), vec![newsletter]);

    f.reset().await?;
    let source = f.message("summary", 9, json!({})).await?;
    for field in ["aiSummary", "reasoning", "modelTier"] {
        assert!(f.repo.get_message(source).await?.unwrap()[field].is_null());
    }
    f.repo.set_tier(source, Some(2)).await?;
    let manual = f.repo.get_message(source).await?.unwrap();
    assert_eq!(manual["tier"], 2);
    assert!(manual["reasoning"].is_null());
    assert!(manual["modelTier"].is_null());
    sqlx::query("update classifications set model='legacy',reasoning='A real model reason' where message_id=?1").bind(source).execute(&f.repo.0).await?;
    let legacy = f.repo.get_message(source).await?.unwrap();
    assert_eq!(legacy["reasoning"], "A real model reason");
    assert_eq!(legacy["modelTier"], 1);
    f.repo
        .save_classification(
            source,
            classification(1, "  Send the revised lab by Friday.  "),
        )
        .await?;
    let detail = f.repo.get_message(source).await?.unwrap();
    for value in [
        detail.clone(),
        f.list("l2", 50, None, None).await?["messages"][0].clone(),
        f.repo.get_thread(uuid(&detail["threadId"]), false).await?[0].clone(),
        f.search("summary", 50, None, None).await?["messages"][0].clone(),
    ] {
        assert_eq!(value["aiSummary"], "Send the revised lab by Friday.");
        assert_eq!(value["tier"], 2);
        assert_eq!(value["modelTier"], 1);
        assert_eq!(value["reasoning"], "A professor directly requests a reply.");
    }
    f.repo
        .save_classification(source, classification(3, "The lab was accepted."))
        .await?;
    let detail = f.repo.get_message(source).await?.unwrap();
    assert_eq!(detail["aiSummary"], "The lab was accepted.");
    assert_eq!(detail["tier"], 2);
    assert_eq!(detail["modelTier"], 3);

    for deleted in [false, true] {
        f.reset().await?;
        let (id, draft) = f.queued_draft().await?;
        if deleted {
            sqlx::query("delete from messages where account_id=?1")
                .bind(f.owner)
                .execute(&f.repo.0)
                .await?;
        }
        f.attempts(id, 12).await?;
        f.repo.fail_mutation(id, "Graph 502").await?;
        let restored = f.repo.get_draft(uuid(&draft["id"])).await?.unwrap();
        assert_eq!(restored["body"], draft["body"]);
        assert_eq!(restored["createdAt"], draft["createdAt"]);
        assert_eq!(
            restored["replyToMessageId"],
            if deleted {
                Value::Null
            } else {
                draft["replyToMessageId"].clone()
            }
        );
        assert_eq!(
            restored["forwardOfMessageId"],
            if deleted {
                Value::Null
            } else {
                draft["forwardOfMessageId"].clone()
            }
        );
        assert_eq!(f.status(id).await?, "failed");
        f.repo.delete_draft(uuid(&draft["id"])).await?;
        f.repo.fail_mutation(id, "Repeated failure").await?;
        assert!(f.repo.get_draft(uuid(&draft["id"])).await?.is_none());
    }
    f.reset().await?;
    let (id, draft) = f.queued_draft().await?;
    sqlx::query("insert into drafts(id,account_id,body) values(?1,?2,'New content')")
        .bind(uuid(&draft["id"]))
        .bind(f.owner)
        .execute(&f.repo.0)
        .await?;
    f.attempts(id, 12).await?;
    f.repo.fail_mutation(id, "Graph 502").await?;
    assert_eq!(
        f.repo.get_draft(uuid(&draft["id"])).await?.unwrap()["body"],
        "New content"
    );
    for attempt in [1, 8, 11] {
        f.reset().await?;
        let (id, draft) = f.queued_draft().await?;
        f.attempts(id, attempt).await?;
        f.repo.fail_mutation(id, "Graph 502").await?;
        assert!(f.repo.get_draft(uuid(&draft["id"])).await?.is_none());
        assert_eq!(f.status(id).await?, "pending");
    }
    f.reset().await?;
    let source = f.message("archive", 8, json!({})).await?;
    let id = f.repo.enqueue_action(source, "archive", None).await?;
    for attempt in [8, 11, 12] {
        f.attempts(id, attempt).await?;
        f.repo.fail_mutation(id, "Graph 502").await?;
        assert_eq!(
            f.status(id).await?,
            if attempt == 12 { "failed" } else { "pending" }
        );
    }
    f.repo
        .fail_mutation(Uuid::new_v4(), "Missing mutation")
        .await?;
    assert_eq!(f.repo.list_drafts().await?, json!([]));

    f.reset().await?;
    let (id, draft) = f.queued_draft().await?;
    f.attempts(id, 12).await?;
    sqlx::query(
        "update mutation_outbox set payload=json_set(payload,'$.draft.accountId',?2) where id=?1",
    )
    .bind(id)
    .bind(Uuid::new_v4().to_string())
    .execute(&f.repo.0)
    .await?;
    assert!(f.repo.fail_mutation(id, "Graph 502").await.is_err());
    assert_eq!(f.status(id).await?, "processing");
    assert!(f.repo.get_draft(uuid(&draft["id"])).await?.is_none());

    f.reset().await?;
    let (id, draft) = f.queued_draft().await?;
    f.attempts(id, 1).await?;
    let (a, b) = tokio::join!(
        f.repo.record_send_attempt(id),
        f.repo.record_send_attempt(id)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    f.repo.fail_mutation(id, "Connection reset").await?;
    assert_eq!(f.status(id).await?, "failed");
    let row = sqlx::query("select last_error,payload from mutation_outbox where id=?1")
        .bind(id)
        .fetch_one(&f.repo.0)
        .await?;
    assert!(
        row.get::<String, _>("last_error")
            .contains("Automatic resend blocked")
    );
    assert!(row.get::<Value, _>("payload")["sendAttemptedAt"].is_string());
    assert!(f.repo.get_draft(uuid(&draft["id"])).await?.is_none());
    assert!(f.repo.claim_mutations(50).await?.is_empty());

    f.reset().await?;
    f.repo.heartbeat("main", json!({})).await?;
    f.repo.finish_sync(f.owner, None, true).await?;
    let recent = f.repo.health().await?;
    assert_eq!(recent["status"], "degraded");
    assert_eq!(recent["sync"]["stale"], 1);
    f.repo.finish_sync(f.other, None, true).await?;
    assert_eq!(f.repo.health().await?["status"], "ok");
    sqlx::query("update accounts set last_synced_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now','-4 minutes') where id=?1")
        .bind(f.owner)
        .execute(&f.repo.0)
        .await?;
    assert_eq!(f.repo.health().await?["sync"]["stale"], 1);
    f.repo.finish_sync(f.owner, None, true).await?;
    f.repo.fail_sync(f.owner, "unauthorized", true).await?;
    let health = f.repo.health().await?;
    assert_eq!(health["status"], "degraded");
    assert_eq!(health["sync"]["needsReauth"], 1);
    assert_eq!(health["sync"]["stale"], 0);
    sqlx::raw_sql("delete from accounts; delete from worker_state")
        .execute(&f.repo.0)
        .await?;
    let empty = f.repo.health().await?;
    assert_eq!(empty["status"], "degraded");
    assert_eq!(
        empty["sync"],
        json!({"accounts":0,"needsReauth":0,"oldestSuccessfulSyncAt":null,"stale":0,"fresh":true})
    );
    f.repo.heartbeat("main", json!({})).await?;
    assert_eq!(f.repo.health().await?["status"], "ok");
    assert!(f.repo.get_message(Uuid::new_v4()).await?.is_none());
    assert!(
        f.repo
            .get_thread(Uuid::new_v4(), false)
            .await?
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        f.repo
            .list_messages(ListInput {
                limit: Some(0),
                ..Default::default()
            })
            .await
            .is_err()
    );
    f.repo.0.close().await;
    println!(
        "Ported mail-view, undo, send-checkpoint, failure-restoration, summary and health cases passed"
    );
    Ok(())
}

fn classification(tier: i32, summary: &str) -> Classification<'_> {
    Classification {
        tier,
        reasoning: "A professor directly requests a reply.",
        summary,
        plain_text: "Please reply.",
        model: "test-model",
        prompt_version: "test",
    }
}
