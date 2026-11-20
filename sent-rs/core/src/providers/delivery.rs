use super::gmail::encode_segment;
use super::*;
use crate::{ingest::StoredAccount, repository::Address};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::future::Future;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub content_type: String,
    pub content_base64: String,
}

pub struct OutgoingMessage {
    pub from: String,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub subject: String,
    pub body: String,
    pub in_reply_to: Option<String>,
    pub reply_to_provider_message_id: Option<String>,
    pub forward_of_provider_message_id: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<OutgoingAttachment>,
}

pub fn gmail_mime(message: &OutgoingMessage) -> Result<Vec<u8>> {
    use lettre::{
        Message,
        message::{Attachment, Mailbox, MultiPart, SinglePart, header::ContentType},
    };
    let mut builder = Message::builder().from(message.from.parse()?);
    let mailbox = |a: &Address| -> Result<Mailbox> {
        Ok(Mailbox::new(
            if a.name.is_empty() {
                None
            } else {
                Some(a.name.clone())
            },
            a.address.parse()?,
        ))
    };
    for a in &message.to {
        builder = builder.to(mailbox(a)?);
    }
    for a in &message.cc {
        builder = builder.cc(mailbox(a)?);
    }
    for a in &message.bcc {
        builder = builder.bcc(mailbox(a)?);
    }
    builder = builder.subject(&message.subject);
    if let Some(id) = &message.in_reply_to {
        builder = builder.in_reply_to(id.clone());
    }
    if !message.references.is_empty() {
        builder = builder.references(message.references.join(" "));
    }
    let mut parts = MultiPart::mixed().singlepart(SinglePart::plain(message.body.clone()));
    for attachment in &message.attachments {
        parts = parts.singlepart(
            Attachment::new(attachment.filename.clone()).body(
                STANDARD.decode(&attachment.content_base64)?,
                ContentType::parse(&attachment.content_type)
                    .map_err(|_| anyhow::anyhow!("Invalid attachment content type"))?,
            ),
        );
    }
    Ok(builder.multipart(parts)?.formatted())
}

impl Providers {
    async fn add_graph_attachment(
        &self,
        token: &str,
        draft: &str,
        attachment: &OutgoingAttachment,
    ) -> Result<()> {
        let url = format!(
            "{}/me/messages/{}/attachments",
            self.endpoints.graph,
            encode_segment(draft)
        );
        let bytes = STANDARD.decode(&attachment.content_base64)?;
        if bytes.len() < 3 * 1024 * 1024 {
            self.api(token,Method::POST,&url,Some(json!({"@odata.type":"#microsoft.graph.fileAttachment","name":attachment.filename,"contentType":attachment.content_type,"contentBytes":attachment.content_base64}))).await?;
            return Ok(());
        }
        let session=self.api(token,Method::POST,&format!("{url}/createUploadSession"),Some(json!({"AttachmentItem":{"attachmentType":"file","name":attachment.filename,"contentType":attachment.content_type,"size":bytes.len()}}))).await?;
        let upload = session["uploadUrl"]
            .as_str()
            .context("Missing attachment upload URL")?;
        let mut offset = 0;
        let range_pattern = regex::Regex::new(r"^\d+(?:-\d*)?$").unwrap();
        while offset < bytes.len() {
            let end = (offset + 10 * 320 * 1024).min(bytes.len());
            let response = self
                .http
                .put(upload)
                .header("Content-Type", "application/octet-stream")
                .header("Content-Length", end - offset)
                .header(
                    "Content-Range",
                    format!("bytes {offset}-{}/{total}", end - 1, total = bytes.len()),
                )
                .body(bytes[offset..end].to_vec())
                .send()
                .await
                .map_err(|_| anyhow::anyhow!("Microsoft attachment upload transport failed"))?;
            let status = response.status();
            ensure!(
                status.is_success(),
                "Microsoft attachment upload failed (HTTP {})",
                status.as_u16()
            );
            if status == reqwest::StatusCode::CREATED {
                ensure!(
                    end == bytes.len(),
                    "Microsoft attachment upload finished early"
                );
                return Ok(());
            }
            let response: Value = response.json().await.map_err(|_| {
                anyhow::anyhow!("Microsoft attachment upload did not confirm progress")
            })?;
            let next = response["nextExpectedRanges"][0]
                .as_str()
                .filter(|s| range_pattern.is_match(s))
                .and_then(|s| s.split('-').next())
                .and_then(|s| s.parse::<usize>().ok());
            ensure!(
                next.is_some_and(|n| n > offset && n < bytes.len() && n <= end),
                "Microsoft attachment upload did not confirm progress"
            );
            offset = next.unwrap();
        }
        bail!("Microsoft attachment upload did not confirm progress")
    }

    pub async fn send<F, Fut>(
        &self,
        account: &StoredAccount,
        message: &OutgoingMessage,
        checkpoint: F,
    ) -> Result<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        if self.config.fake_providers {
            checkpoint().await?;
            return Ok(format!("fake-sent-{}", Uuid::new_v4()));
        }
        if account.provider == "microsoft" {
            ensure!(
                self.config.microsoft_mail_send_enabled,
                "Sending from Purdue requires Microsoft Mail.Send approval"
            );
        }
        let token = self
            .access_token(
                account.id,
                &account.provider,
                &account.encrypted_credentials,
            )
            .await?;
        if account.provider == "gmail" {
            let raw = gmail_mime(message)?;
            checkpoint().await?;
            let response = self
                .api(
                    &token,
                    Method::POST,
                    &format!("{}/users/me/messages/send", self.endpoints.gmail),
                    Some(json!({"raw":URL_SAFE_NO_PAD.encode(raw)})),
                )
                .await?;
            return Ok(response["id"]
                .as_str()
                .context("Gmail did not return a sent message id")?
                .into());
        }
        let recipients = |items: &[Address]| {
            items
                .iter()
                .map(|a| json!({"emailAddress":{"name":a.name,"address":a.address}}))
                .collect::<Vec<_>>()
        };
        let body = json!({"subject":message.subject,"body":{"contentType":"Text","content":message.body},"toRecipients":recipients(&message.to),"ccRecipients":recipients(&message.cc),"bccRecipients":recipients(&message.bcc)});
        let source = message
            .reply_to_provider_message_id
            .as_ref()
            .or(message.forward_of_provider_message_id.as_ref());
        let url = if let Some(id) = source {
            format!(
                "{}/me/messages/{}/{}",
                self.endpoints.graph,
                encode_segment(id),
                if message.reply_to_provider_message_id.is_some() {
                    "createReply"
                } else {
                    "createForward"
                }
            )
        } else {
            format!("{}/me/messages", self.endpoints.graph)
        };
        let draft = self
            .api(
                &token,
                Method::POST,
                &url,
                Some(if source.is_some() {
                    json!({})
                } else {
                    body.clone()
                }),
            )
            .await?;
        let id = draft["id"]
            .as_str()
            .context("Microsoft did not return a draft id")?;
        let draft_url = format!(
            "{}/me/messages/{}",
            self.endpoints.graph,
            encode_segment(id)
        );
        let prepare = async {
            if source.is_some() {
                self.api(&token, Method::PATCH, &draft_url, Some(body))
                    .await?;
            }
            for attachment in &message.attachments {
                self.add_graph_attachment(&token, id, attachment).await?;
            }
            checkpoint().await
        }
        .await;
        if let Err(error) = prepare {
            let _ = self.api(&token, Method::DELETE, &draft_url, None).await;
            return Err(error);
        }
        self.api(&token, Method::POST, &format!("{draft_url}/send"), None)
            .await?;
        Ok(id.into())
    }
}
