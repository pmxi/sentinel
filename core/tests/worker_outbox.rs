use anyhow::Result;
use sent_core::db::Uuid;
use sent_core::{
    config::Config,
    crypto::encrypt_secret,
    db,
    providers::{Endpoints, Providers},
    repository::{Address, DraftInput, Repository, ThreadActionInput},
    services::Services,
};
use serde_json::{Value, json};
use sqlx::Row;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

#[tokio::test]
async fn outbox_delivery_safety_fake_sync_and_reauthentication() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let database_path = directory.path().join("sent.sqlite");
    let pool = db::pool(database_path.to_str().unwrap(), true).await?;
    let mut config = Config::from_env()?;
    db::migrate(&pool, &config.migrations_path).await?;
    let repository = Repository(pool.clone());
    config.fake_providers = false;
    config.token_encryption_key = Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=".into());
    let credentials=encrypt_secret(&json!({"access_token":"mock-token","expiry_date":chrono::Utc::now().timestamp_millis()+86400000}).to_string(),config.token_encryption_key.as_deref().unwrap())?;
    let account = repository
        .upsert_account(
            "gmail",
            &format!("worker-{}@example.test", Uuid::new_v4()),
            "Worker",
            &credentials,
        )
        .await?;
    let server = MockServer::start().await;
    let mut service = Services::new(config.clone(), repository.clone());
    service.providers = Providers::with_endpoints(
        config,
        pool.clone(),
        Endpoints {
            gmail: server.uri(),
            graph: server.uri(),
            google_token: format!("{}/token", server.uri()),
            microsoft_token: format!("{}/token", server.uri()),
        },
    );
    for scenario in [
        "lost-response",
        "completion-failed",
        "pre-dispatch",
        "repeated-failures",
    ] {
        server.reset().await;
        let draft = repository
            .save_draft(DraftInput {
                id: None,
                account_id: account,
                to: vec![Address {
                    name: "Recipient".into(),
                    address: "recipient@example.test".into(),
                }],
                cc: vec![],
                bcc: vec![],
                subject: "Test".into(),
                body: "Test".into(),
                reply_to_message_id: None,
                forward_of_message_id: None,
            })
            .await?;
        let id = repository
            .enqueue_send(
                serde_json::from_value(draft["id"].clone())?,
                json!([]),
                None,
            )
            .await?;
        let respond = if scenario == "lost-response" {
            ResponseTemplate::new(500)
        } else {
            ResponseTemplate::new(200).set_body_json(json!({"id":"sent-id"}))
        };
        Mock::given(path("/users/me/messages/send"))
            .and(method("POST"))
            .respond_with(respond)
            .mount(&server)
            .await;
        if scenario == "completion-failed" {
            repository.claim_mutations(25).await?;
            repository.record_send_attempt(id).await?;
            sqlx::query("update mutation_outbox set next_attempt_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now') where id=?1")
                .bind(id)
                .execute(&pool)
                .await?;
            service.process_outbox().await?;
            assert!(server.received_requests().await.unwrap().is_empty());
        } else if ["pre-dispatch", "repeated-failures"].contains(&scenario) {
            let attempts = if scenario == "repeated-failures" {
                12
            } else {
                1
            };
            sqlx::query("update mutation_outbox set payload=json_set(payload,'$.attachments',json('[{\"filename\":\"bad\",\"contentType\":\"text/plain\",\"contentBase64\":\"!notbase64\"}]')) where id=?1").bind(id).execute(&pool).await?;
            for _ in 0..attempts {
                sqlx::query("update mutation_outbox set next_attempt_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now') where id=?1")
                    .bind(id)
                    .execute(&pool)
                    .await?;
                service.process_outbox().await?;
            }
            let attempted: bool = sqlx::query_scalar(
                "select json_extract(payload,'$.sendAttemptedAt') is not null from mutation_outbox where id=?1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await?;
            assert!(!attempted);
            if scenario == "pre-dispatch" {
                sqlx::query("update mutation_outbox set payload=json_set(payload,'$.attachments',json('[]')),next_attempt_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now') where id=?1").bind(id).execute(&pool).await?;
                service.process_outbox().await?;
                assert_eq!(server.received_requests().await.unwrap().len(), 1);
            } else {
                assert!(
                    repository
                        .get_draft(serde_json::from_value(draft["id"].clone())?)
                        .await?
                        .is_some()
                );
            }
        } else {
            service.process_outbox().await?;
            sqlx::query("update mutation_outbox set next_attempt_at=strftime('%Y-%m-%dT%H:%M:%f000Z','now') where id=?1")
                .bind(id)
                .execute(&pool)
                .await?;
            service.process_outbox().await?;
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
        let row = sqlx::query("select status,payload from mutation_outbox where id=?1")
            .bind(id)
            .fetch_one(&pool)
            .await?;
        assert_eq!(
            row.get::<String, _>("status"),
            if scenario == "pre-dispatch" {
                "complete"
            } else {
                "failed"
            }
        );
    }
    for provider in ["gmail", "microsoft"] {
        let token = if provider == "gmail" {
            json!({"access_token":"mock-token","expiry_date":chrono::Utc::now().timestamp_millis()+86400000})
        } else {
            json!({"homeAccountId":"home","cache":json!({"AccessToken":{"token":{"home_account_id":"home","secret":"mock-token","expires_on":(chrono::Utc::now().timestamp()+86400).to_string()}}}).to_string()})
        };
        let encrypted = encrypt_secret(
            &token.to_string(),
            service.config.token_encryption_key.as_deref().unwrap(),
        )?;
        let owner = repository
            .upsert_account(
                provider,
                &format!("group-{}@example.test", Uuid::new_v4()),
                "Grouped",
                &encrypted,
            )
            .await?;
        for action in ["archive", "delete"] {
            server.reset().await;
            Mock::given(method(if provider == "microsoft" && action == "delete" {
                "DELETE"
            } else {
                "POST"
            }))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(3)
            .mount(&server)
            .await;
            let thread: Uuid = sqlx::query_scalar(
                "insert into threads(account_id,provider_thread_id,last_message_at,id) values(?1,?2,strftime('%Y-%m-%dT%H:%M:%f000Z','now'),?3) returning id",
            )
            .bind(owner)
            .bind(Uuid::new_v4().to_string())
            .bind(Uuid::new_v4())
            .fetch_one(&pool)
            .await?;
            for _ in 0..3 {
                sqlx::query("insert into messages(account_id,thread_id,provider_message_id,received_at,direction,id) values(?1,?2,?3,strftime('%Y-%m-%dT%H:%M:%f000Z','now'),'inbound',?4)")
                    .bind(owner).bind(thread).bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4()).execute(&pool).await?;
            }
            let input = ThreadActionInput {
                action: action.into(),
                view: "all".into(),
                account_id: Some(owner),
                undoable: true,
            };
            let group = repository
                .enqueue_thread_action(
                    thread,
                    &input,
                    Some(chrono::Utc::now() + chrono::Duration::seconds(5)),
                )
                .await?;
            repository.undo(group).await?;
            assert_eq!(service.process_outbox().await?, 0);
            assert!(server.received_requests().await.unwrap().is_empty());
            repository
                .enqueue_thread_action(thread, &input, None)
                .await?;
            assert_eq!(service.process_outbox().await?, 3);
            assert_eq!(server.received_requests().await.unwrap().len(), 3);
            let complete: i64 = sqlx::query_scalar(
                "select count(*) from mutation_outbox where account_id=?1 and status='complete'",
            )
            .bind(owner)
            .fetch_one(&pool)
            .await?;
            assert_eq!(complete, if action == "archive" { 3 } else { 6 });
            assert_eq!(service.process_outbox().await?, 0);
            server.verify().await;
        }
        sqlx::query("delete from accounts where id=?1")
            .bind(owner)
            .execute(&pool)
            .await?;
    }
    server.reset().await;
    Mock::given(path("/users/me/messages"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"error":"unauthorized"})))
        .mount(&server)
        .await;
    assert!(service.sync_account(account).await.is_err());
    let status: String = sqlx::query_scalar("select status from accounts where id=?1")
        .bind(account)
        .fetch_one(&pool)
        .await?;
    assert_eq!(status, "needs_reauth");
    assert!(
        !repository
            .list_stored_accounts()
            .await?
            .iter()
            .any(|a| a.id == account)
    );
    service.config.fake_providers = true;
    let mut fake_config = service.config.clone();
    fake_config.fake_providers = true;
    service.providers = Providers::new(fake_config, pool.clone());
    let before = server.received_requests().await.unwrap().len();
    assert!(service.sync_account(account).await?.is_empty());
    let health = repository.health().await?;
    assert_eq!(health["database"], true);
    let draft: Value = repository
        .save_draft(DraftInput {
            id: None,
            account_id: account,
            to: vec![],
            cc: vec![],
            bcc: vec![],
            subject: "Fake send".into(),
            body: "Local only".into(),
            reply_to_message_id: None,
            forward_of_message_id: None,
        })
        .await?;
    repository
        .enqueue_send(
            serde_json::from_value(draft["id"].clone())?,
            json!([]),
            None,
        )
        .await?;
    service.process_outbox().await?;
    let sent:i64=sqlx::query_scalar("select count(*) from messages where account_id=?1 and direction='outbound' and subject='Fake send'").bind(account).fetch_one(&pool).await?;
    assert_eq!(sent, 1);
    assert_eq!(server.received_requests().await.unwrap().len(), before);
    sqlx::query("delete from accounts where id=?1")
        .bind(account)
        .execute(&pool)
        .await?;
    Ok(())
}
