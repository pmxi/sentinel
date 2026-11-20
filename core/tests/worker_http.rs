use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use sent_core::{
    ai::{ClassificationResult, Intelligence, ReaderLinks, embedding_fallback_input},
    config::Config,
    crypto::encrypt_secret,
    ingest::StoredAccount,
    normalize::{self, parse_addresses, sanitize_email_html},
    providers::{Endpoints, OutgoingAttachment, OutgoingMessage, Providers},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path, query_param},
};

const KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
fn config() -> Config {
    let mut c = Config::from_env().unwrap();
    c.fake_providers = false;
    c.token_encryption_key = Some(KEY.into());
    c.microsoft_mail_send_enabled = true;
    c.openai_api_key = Some("mock-key".into());
    c
}
fn account(provider: &str) -> StoredAccount {
    let credentials = if provider == "gmail" {
        json!({"access_token":"test-token","expiry_date":Utc::now().timestamp_millis()+86400000})
    } else {
        json!({"homeAccountId":"home","cache":json!({"AccessToken":{"token":{"home_account_id":"home","secret":"test-token","expires_on":(Utc::now().timestamp()+86400).to_string()}}}).to_string()})
    };
    StoredAccount {
        id: Uuid::new_v4(),
        provider: provider.into(),
        email: "paras@example.edu".into(),
        display_name: "Paras".into(),
        encrypted_credentials: encrypt_secret(&credentials.to_string(), KEY).unwrap(),
    }
}
fn providers(server: &MockServer, c: Config) -> Providers {
    let root = server.uri();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://localhost/sent_test_unused")
        .unwrap();
    Providers::with_endpoints(
        c,
        pool,
        Endpoints {
            gmail: root.clone(),
            graph: root.clone(),
            google_token: format!("{root}/token"),
            microsoft_token: format!("{root}/token"),
        },
    )
}
fn full_message() -> Value {
    json!({"id":"message-1","conversationId":"thread-1","internetMessageId":"<message-1@example.com>","subject":"A complete message","from":{"emailAddress":{"name":"Ada","address":"ada@example.com"}},"toRecipients":[{"emailAddress":{"name":"Paras","address":"paras@example.edu"}}],"ccRecipients":[],"bccRecipients":[],"sentDateTime":"2026-08-20T12:00:00Z","receivedDateTime":"2026-08-20T12:00:01Z","lastModifiedDateTime":"2026-08-20T12:05:00Z","bodyPreview":"Hello Paras","body":{"contentType":"text","content":"Hello Paras"},"isRead":true,"flag":{"flagStatus":"notFlagged"},"parentFolderId":"inbox","isDraft":false,"hasAttachments":false})
}
fn cursor(server: &MockServer) -> Value {
    json!({"version":1,"sentFolderId":"sent-folder","folders":[{"id":"inbox","name":"Inbox","delta":format!("{}/delta",server.uri()),"next":null}],"index":0,"backfill":false,"folderRefreshAt":Utc::now().to_rfc3339()})
}
fn outgoing(size: usize) -> OutgoingMessage {
    OutgoingMessage {
        from: "paras@example.edu".into(),
        to: parse_addresses("Recipient <recipient@example.com>"),
        cc: vec![],
        bcc: vec![],
        subject: "Attachments".into(),
        body: "See attached.".into(),
        in_reply_to: None,
        reply_to_provider_message_id: None,
        forward_of_provider_message_id: None,
        references: vec![],
        attachments: if size == 0 {
            vec![]
        } else {
            vec![OutgoingAttachment {
                filename: format!("file-{size}.bin"),
                content_type: "application/octet-stream".into(),
                content_base64: STANDARD.encode(vec![0x5a; size]),
            }]
        },
    }
}

#[test]
fn normalization_and_reader_references() {
    let addresses =
        parse_addresses("Paras Mittal <paras@example.com>, \"Ada L\" <ADA@example.org>");
    assert_eq!(addresses[0].name, "Paras Mittal");
    assert_eq!(addresses[1].address, "ada@example.org");
    let html = sanitize_email_html(
        "<script>alert(1)</script><img src=\"https://example.com/pixel\"><a href=\"javascript:bad()\">x</a>",
    );
    assert!(!html.contains("script"));
    assert!(!html.contains("javascript:"));
    assert!(html.contains("https://example.com/pixel"));
    let url = format!(
        "https://example.com/{}?data=a%7Cb%7Cc&part=(1)#notes",
        "token_abc-".repeat(70)
    );
    let links = ReaderLinks::new(&format!("Open [{url}] Same [{url}]"));
    assert!(!links.input.contains("sent-link-2"));
    assert_eq!(
        links.finish("[Open][sent-link-1]").unwrap(),
        format!("[Open][sent-link-1]\n\n[sent-link-1]: <{url}>")
    );
    let links = ReaderLinks::new("https://example.com/one https://example.com/two");
    assert_eq!(
        links
            .finish("[Go][sent-link-2] and [again][sent-link-2]")
            .unwrap(),
        "[Go][sent-link-2] and [again][sent-link-2]\n\n[sent-link-2]: <https://example.com/two>"
    );
    assert_eq!(
        links.finish("No useful links.").unwrap(),
        "No useful links."
    );
    assert!(
        links
            .finish("[Go][sent-link-99]")
            .unwrap_err()
            .to_string()
            .contains("unknown link")
    );
    assert!(links.finish("[Go](<https://example.com/altered>)").is_err());
    assert!(
        links
            .finish("[Go][sent-link-1]\n[sent-link-1]: <https://example.com/one>")
            .unwrap_err()
            .to_string()
            .contains("own link definitions")
    );
    assert!(links.finish("[Go](<https://example.com/one>)").is_ok());
    let text = format!(
        "{}{}{}",
        "start ".repeat(2000),
        "😀".repeat(10000),
        " end".repeat(2000)
    );
    let fallback = embedding_fallback_input(&text);
    assert!(fallback.len() <= 7500);
    assert!(fallback.starts_with("start"));
    assert!(fallback.ends_with("end"));
    assert!(fallback.contains("middle omitted"));
    assert_eq!(embedding_fallback_input(""), "");
    for bad in [
        json!({"reasoning":"","tier":4}),
        json!({"reasoning":"ok","tier":1,"plainText":""}),
        json!({"reasoning":"ok","tier":1,"plainText":"","summary":"   "}),
        json!({"reasoning":"ok","tier":1,"plainText":"","summary":"x".repeat(281)}),
    ] {
        assert!(
            serde_json::from_value::<ClassificationResult>(bad)
                .and_then(|mut r| r.validate().map(|_| r).map_err(serde::de::Error::custom))
                .is_err()
        );
    }
    assert_eq!(
        normalize::content_hash("hello"),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
}

#[tokio::test]
async fn microsoft_delta_snapshots_hydration_and_sent_identity() {
    for scenario in [
        "complete",
        "localized-sent",
        "user-sent-folder",
        "legacy",
        "partial",
        "gone",
        "timestamp",
        "draft",
        "removed",
    ] {
        let server = MockServer::start().await;
        let provider = providers(&server, config());
        let mut state = cursor(&server);
        let mut full = full_message();
        if scenario == "localized-sent" {
            state["folders"][0]["id"] = json!("sent-folder");
            state["folders"][0]["name"] = json!("Éléments envoyés");
            full["parentFolderId"] = json!("sent-folder");
            full["from"]["emailAddress"]["address"] = json!("other-alias@example.edu");
        }
        if scenario == "user-sent-folder" {
            state["folders"][0]["name"] = json!("Sent Items");
        }
        if scenario == "legacy" {
            state.as_object_mut().unwrap().remove("sentFolderId");
            Mock::given(path("/me/mailFolders/sentitems"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"sent-folder"})))
                .expect(1)
                .mount(&server)
                .await;
        }
        if scenario == "timestamp" {
            full["sentDateTime"] = Value::Null;
            full["receivedDateTime"] = Value::Null;
        }
        let source = match scenario {
            "partial" | "gone" => json!({"id":"message-1","isRead":true}),
            "draft" => {
                full["isDraft"] = json!(true);
                full.clone()
            }
            "removed" => json!({"id":"message-1","@removed":{"reason":"deleted"}}),
            _ => full.clone(),
        };
        Mock::given(path("/delta"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"value":[source],"@odata.deltaLink":format!("{}/next-delta",server.uri())}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(path("/me/messages/message-1"))
            .respond_with(if scenario == "gone" {
                ResponseTemplate::new(404)
            } else {
                ResponseTemplate::new(200).set_body_json(full)
            })
            .expect(if ["partial", "gone"].contains(&scenario) {
                1
            } else {
                0
            })
            .mount(&server)
            .await;
        let page = provider
            .sync(&account("microsoft"), Some(&state.to_string()))
            .await;
        if scenario == "timestamp" {
            assert!(
                page.err()
                    .unwrap()
                    .to_string()
                    .contains("missing its received and sent timestamps")
            );
            continue;
        }
        let page = page.unwrap();
        assert!(page.backfill_complete);
        let next: Value = serde_json::from_str(page.next_cursor.as_deref().unwrap()).unwrap();
        assert_eq!(next["sentFolderId"], "sent-folder");
        assert_eq!(
            next["folders"][0]["delta"],
            format!("{}/next-delta", server.uri())
        );
        if ["gone", "removed"].contains(&scenario) {
            assert!(page.messages.is_empty());
            assert_eq!(page.deleted_provider_message_ids, vec!["message-1"]);
        } else if scenario == "draft" {
            assert!(page.messages.is_empty());
        } else {
            assert_eq!(page.messages.len(), 1);
            let message = &page.messages[0];
            assert_eq!(
                message.direction,
                if scenario == "localized-sent" {
                    "outbound"
                } else {
                    "inbound"
                }
            );
            assert_eq!(message.subject, "A complete message");
            assert_eq!(message.text_body, "Hello Paras");
            assert_eq!(
                message.received_at.to_rfc3339(),
                "2026-08-20T12:00:01+00:00"
            );
        }
    }
}

#[tokio::test]
async fn microsoft_folder_backfill_and_page_continuation() {
    let server = MockServer::start().await;
    let provider = providers(&server, config());
    let account = account("microsoft");
    Mock::given(path("/me/mailFolders/sentitems"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"sent-folder"})))
        .mount(&server)
        .await;
    Mock::given(path("/me/mailFolders")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"value":[{"id":"inbox","displayName":"Inbox","childFolderCount":1},{"id":"sent-folder","displayName":"Éléments envoyés"}]}))).mount(&server).await;
    Mock::given(path("/me/mailFolders/inbox/childFolders"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"value":[{"id":"child","displayName":"Child"}]})),
        )
        .mount(&server)
        .await;
    for folder in ["inbox", "sent-folder", "child"] {
        Mock::given(path(format!("/me/mailFolders/{folder}/messages/delta")))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"value":[],"@odata.deltaLink":format!("{}/{folder}-delta",server.uri())}),
            ))
            .expect(1)
            .mount(&server)
            .await;
    }
    let mut page = provider.sync(&account, None).await.unwrap();
    assert!(!page.backfill_complete);
    for index in 0..3 {
        page = provider
            .sync(&account, page.next_cursor.as_deref())
            .await
            .unwrap();
        assert_eq!(page.backfill_complete, index == 2);
    }
    let state: Value = serde_json::from_str(page.next_cursor.as_deref().unwrap()).unwrap();
    assert_eq!(
        state["folders"][0]["delta"],
        format!("{}/inbox-delta", server.uri())
    );
    assert_eq!(
        state["folders"][1]["delta"],
        format!("{}/sent-folder-delta", server.uri())
    );
}

#[tokio::test]
async fn gmail_history_pagination_deletions_and_expiry() {
    for expired in [false, true] {
        let server = MockServer::start().await;
        let provider = providers(&server, config());
        Mock::given(path("/users/me/history")).and(query_param("startHistoryId","10")).respond_with(if expired {ResponseTemplate::new(404)}else{ResponseTemplate::new(200).set_body_json(json!({"historyId":"11","nextPageToken":"page2","history":[{"messagesAdded":[{"message":{"id":"one"}},{"message":{"id":"gone"}}],"labelsAdded":[{"message":{"id":"one"}}],"messagesDeleted":[{"message":{"id":"gone"}}]}]}))}).with_priority(2).mount(&server).await;
        Mock::given(path("/users/me/history")).and(query_param("pageToken","page2")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"historyId":"12","history":[{"labelsRemoved":[{"message":{"id":"missing"}}]}]}))).with_priority(1).mount(&server).await;
        Mock::given(path("/users/me/messages/one")).respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"one","threadId":"thread","internalDate":"1736942400000","labelIds":["INBOX","UNREAD"],"payload":{"headers":[{"name":"Subject","value":"A note"}],"mimeType":"text/plain","body":{"data":"SGVsbG8"}}}))).mount(&server).await;
        Mock::given(path("/users/me/messages/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        Mock::given(path("/users/me/messages"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"messages":[{"id":"one"}]})),
            )
            .mount(&server)
            .await;
        Mock::given(path("/users/me/profile"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"historyId":"99"})))
            .mount(&server)
            .await;
        let page = provider
            .sync(&account("gmail"), Some("history:10"))
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].text_body, "Hello");
        assert!(!page.messages[0].read);
        assert_eq!(
            page.next_cursor.as_deref(),
            Some(if expired { "history:99" } else { "history:12" })
        );
        assert_eq!(
            page.deleted_provider_message_ids.len(),
            if expired { 0 } else { 2 }
        );
    }
}

#[tokio::test]
async fn fake_providers_and_marked_accounts_cannot_contact_providers() {
    let server = MockServer::start().await;
    let mut c = config();
    c.fake_providers = true;
    let provider = providers(&server, c);
    let mut account = account("gmail");
    account.encrypted_credentials = "sent-fake-provider:no-live-credentials".into();
    assert!(
        provider
            .sync(&account, None)
            .await
            .unwrap()
            .backfill_complete
    );
    provider
        .apply_action(&account, "id", "archive")
        .await
        .unwrap();
    provider
        .send(&account, &outgoing(0), || async { Ok(()) })
        .await
        .unwrap();
    let live = providers(&server, config());
    assert!(
        live.sync(&account, None)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("Fake accounts")
    );
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn openai_strict_output_links_empty_invalid_and_embedding_fallback() {
    let server = MockServer::start().await;
    let ai = Intelligence::with_base_url(config(), server.uri());
    Mock::given(path("/responses")).respond_with(|request:&wiremock::Request|{let body:Value=request.body_json().unwrap();assert_eq!(body["text"]["format"]["strict"],true);assert_eq!(body["text"]["format"]["schema"]["additionalProperties"],false);assert_eq!(body["store"],false);assert_eq!(body["reasoning"]["effort"],"xhigh");let input=body["input"].as_str().unwrap();let output=if input=="empty"{json!({"output":[]})}else{let result=if input=="bad"{json!({"reasoning":"why","summary":" ","tier":4,"plainText":""})}else{json!({"reasoning":"Human request","summary":" Reply by Friday. ","tier":1,"plainText":"[Open][sent-link-1]"})};json!({"output":[{"type":"message","content":[{"type":"output_text","text":result.to_string()}]}]})};ResponseTemplate::new(200).set_body_json(output)}).mount(&server).await;
    let result = ai
        .classify("https://example.com/a?token=exact")
        .await
        .unwrap();
    assert_eq!(result.summary, "Reply by Friday.");
    assert!(
        result
            .plain_text
            .ends_with("<https://example.com/a?token=exact>")
    );
    assert_eq!(result.prompt_version.len(), 12);
    assert!(ai.classify("empty").await.is_err());
    assert!(ai.classify("bad").await.is_err());
    Mock::given(path("/embeddings"))
        .respond_with(|request: &wiremock::Request| {
            let body: Value = request.body_json().unwrap();
            if body["input"].as_str().unwrap().len() > 7500 {
                ResponseTemplate::new(400)
                    .set_body_json(json!({"error":{"message":"maximum context length"}}))
            } else {
                ResponseTemplate::new(200).set_body_json(json!({"data":[{"embedding":[0.1,0.2]}]}))
            }
        })
        .mount(&server)
        .await;
    assert_eq!(
        ai.embed(&"😀".repeat(10000)).await.unwrap().0,
        vec![0.1, 0.2]
    );
}

#[tokio::test]
async fn microsoft_attachment_boundaries_reply_forward_and_checkpoint() {
    for (kind, size) in [
        ("new", 3 * 1024 * 1024 - 1),
        ("reply", 3 * 1024 * 1024),
        ("forward", 7 * 1024 * 1024 + 19),
    ] {
        let server = MockServer::start().await;
        let provider = providers(&server, config());
        let upload = format!("{}/upload", server.uri());
        let upload_clone = upload.clone();
        Mock::given(method("POST"))
            .respond_with(move |request: &wiremock::Request| {
                if request.url.path().ends_with("/send") {
                    return ResponseTemplate::new(202);
                }
                if request.url.path().ends_with("createUploadSession") {
                    ResponseTemplate::new(200).set_body_json(json!({"uploadUrl":upload_clone}))
                } else {
                    ResponseTemplate::new(200).set_body_json(json!({"id":"draft-1"}))
                }
            })
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(&server)
            .await;
        Mock::given(path("/upload"))
            .respond_with(move |request: &wiremock::Request| {
                assert!(!request.headers.contains_key("authorization"));
                assert_eq!(request.headers["content-type"], "application/octet-stream");
                let range = request.headers["content-range"].to_str().unwrap();
                let end = range
                    .split('-')
                    .nth(1)
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()
                    + 1;
                assert!(request.body.len() < 4 * 1024 * 1024);
                if end == size {
                    ResponseTemplate::new(201)
                } else {
                    ResponseTemplate::new(200)
                        .set_body_json(json!({"nextExpectedRanges":[end.to_string()]}))
                }
            })
            .mount(&server)
            .await;
        let mut message = outgoing(size);
        if kind == "reply" {
            message.reply_to_provider_message_id = Some("source/+".into());
        }
        if kind == "forward" {
            message.forward_of_provider_message_id = Some("source/+".into());
        }
        let checkpoint = Arc::new(AtomicUsize::new(0));
        let flag = checkpoint.clone();
        assert_eq!(
            provider
                .send(&account("microsoft"), &message, || async move {
                    flag.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
                .unwrap(),
            "draft-1"
        );
        assert_eq!(checkpoint.load(Ordering::SeqCst), 1);
        let requests = server.received_requests().await.unwrap();
        assert!(requests.last().unwrap().url.path().ends_with("/send"));
        let initial: Value = requests[0].body_json().unwrap();
        assert!(initial.get("attachments").is_none());
        assert!(initial.get("internetMessageHeaders").is_none());
        assert_eq!(
            requests.iter().any(|r| r.url.path() == "/upload"),
            size >= 3 * 1024 * 1024
        );
    }
}

#[tokio::test]
async fn microsoft_upload_errors_progress_cleanup_and_ambiguous_send() {
    for scenario in [
        "404",
        "429",
        "500",
        "empty",
        "zero",
        "huge",
        "garbage",
        "final",
        "checkpoint",
        "send",
    ] {
        let server = MockServer::start().await;
        let provider = providers(&server, config());
        let upload = format!("{}/upload", server.uri());
        Mock::given(path("/me/messages"))
            .and(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id":"draft-1"})))
            .mount(&server)
            .await;
        Mock::given(path("/me/messages/draft-1/attachments/createUploadSession"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"uploadUrl":upload})))
            .mount(&server)
            .await;
        let response=match scenario {"404"|"429"|"500"=>ResponseTemplate::new(scenario.parse::<u16>().unwrap()).set_body_string("Do not log a signed URL"),_=>ResponseTemplate::new(200).set_body_json(json!({"nextExpectedRanges":match scenario {"empty"=>json!([]),"zero"=>json!(["0-"]),"huge"=>json!(["999999999-"]),"garbage"=>json!(["garbage"]),_=>json!([(3*1024*1024).to_string()])}}))};
        Mock::given(path("/upload"))
            .respond_with(response)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        Mock::given(path("/me/messages/draft-1/send"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let size = if ["checkpoint", "send"].contains(&scenario) {
            0
        } else if scenario == "final" {
            3 * 1024 * 1024
        } else {
            4 * 1024 * 1024
        };
        let error = provider
            .send(&account("microsoft"), &outgoing(size), || async {
                if scenario == "checkpoint" {
                    anyhow::bail!("Checkpoint unavailable");
                }
                Ok(())
            })
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains("authtoken"));
        if ["404", "429", "500"].contains(&scenario) {
            assert!(error.contains(&format!(
                "Microsoft attachment upload failed (HTTP {scenario})"
            )));
        }
        let requests = server.received_requests().await.unwrap();
        assert_eq!(
            requests.iter().any(|r| r.url.path().ends_with("/send")),
            scenario == "send"
        );
        assert_eq!(
            requests.iter().any(|r| r.method == "DELETE"),
            scenario != "send"
        );
    }
}

#[tokio::test]
async fn provider_actions_gmail_mime_backfill_and_reauth_errors() {
    let server = MockServer::start().await;
    let mut c = config();
    c.google_client_id = Some("mock-client".into());
    c.google_client_secret = Some("mock-secret".into());
    let provider = providers(&server, c);
    Mock::given(path("/users/me/messages"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"messages":[],"nextPageToken":"continue"})),
        )
        .mount(&server)
        .await;
    let page = provider
        .sync(&account("gmail"), Some("backfill:first"))
        .await
        .unwrap();
    assert_eq!(page.next_cursor.as_deref(), Some("backfill:continue"));
    assert!(!page.backfill_complete);
    Mock::given(path("/users/me/messages/id/modify"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(6)
        .mount(&server)
        .await;
    for action in [
        "archive",
        "delete",
        "mark_read",
        "mark_unread",
        "flag",
        "unflag",
    ] {
        provider
            .apply_action(&account("gmail"), "id", action)
            .await
            .unwrap();
    }
    Mock::given(path("/users/me/messages/send"))
        .respond_with(|r: &wiremock::Request| {
            let body: Value = r.body_json().unwrap();
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(body["raw"].as_str().unwrap())
                .unwrap();
            let mail = mailparse::parse_mail(&raw).unwrap();
            use mailparse::MailHeaderMap;
            assert_eq!(
                mail.headers.get_first_value("Subject").as_deref(),
                Some("Attachments")
            );
            assert_eq!(
                mail.headers.get_first_value("In-Reply-To").as_deref(),
                Some("<original@example.com>")
            );
            assert_eq!(mail.subparts.len(), 2);
            ResponseTemplate::new(200).set_body_json(json!({"id":"sent-id"}))
        })
        .expect(1)
        .mount(&server)
        .await;
    let mut message = outgoing(32);
    message.in_reply_to = Some("<original@example.com>".into());
    message.references.push("<original@example.com>".into());
    assert_eq!(
        provider
            .send(&account("gmail"), &message, || async { Ok(()) })
            .await
            .unwrap(),
        "sent-id"
    );
    Mock::given(path("/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"error":"invalid_grant"})))
        .expect(1)
        .mount(&server)
        .await;
    let mut stale = account("gmail");
    stale.encrypted_credentials = encrypt_secret(
        &json!({"refresh_token":"mock-refresh","expiry_date":0}).to_string(),
        KEY,
    )
    .unwrap();
    let error = provider.sync(&stale, None).await.err().unwrap().to_string();
    assert!(sent_core::services::needs_reauth(&error));
    assert!(sent_core::services::needs_reauth(
        "Microsoft Graph 401: Unauthorized"
    ));
    assert!(sent_core::services::needs_reauth("interaction_required"));
    assert!(!sent_core::services::needs_reauth("HTTP 429 retry later"));
}
