use crate::{
    ingest::{Container, NormalizedMessage},
    repository::Address,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub fn parse_addresses(value: &str) -> Vec<Address> {
    let Ok(items) = mailparse::addrparse(value) else {
        return vec![];
    };
    items
        .iter()
        .flat_map(|item| match item {
            mailparse::MailAddr::Single(a) => vec![a],
            mailparse::MailAddr::Group(g) => g.addrs.iter().collect(),
        })
        .map(|a| Address {
            name: a.display_name.clone().unwrap_or_default(),
            address: a.addr.to_lowercase(),
        })
        .collect()
}

pub fn sanitize_email_html(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(&[
            "img", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "colgroup", "col", "style",
        ])
        .clean_content_tags(HashSet::from(["script"]))
        .add_generic_attributes(&["class", "dir", "lang", "style", "title"])
        .add_tag_attributes("img", &["src", "alt", "width", "height", "title"])
        .add_tag_attributes("a", &["href", "name", "target", "rel"])
        .add_tag_attributes(
            "table",
            &["border", "cellpadding", "cellspacing", "width", "align"],
        )
        .add_tag_attributes(
            "td",
            &["colspan", "rowspan", "width", "height", "align", "valign"],
        )
        .add_tag_attributes(
            "th",
            &["colspan", "rowspan", "width", "height", "align", "valign"],
        )
        .add_tag_attributes("col", &["span", "width"])
        .url_schemes(HashSet::from(["http", "https", "mailto", "cid"]))
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(None)
        .set_tag_attribute_value("a", "target", "_blank")
        .set_tag_attribute_value("a", "rel", "noopener noreferrer");
    builder.clean(html).to_string()
}

pub fn text_from_html(html: &str) -> String {
    let html = Regex::new(r"(?is)<img\b[^>]*>")
        .unwrap()
        .replace_all(html, "");
    html2text::from_read(html.as_bytes(), 1_000_000)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

pub fn snippet(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

pub fn content_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub fn analysis_text(message: &Value) -> String {
    fn addresses(value: &Value) -> String {
        value
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| {
                let name = a["name"].as_str().unwrap_or("");
                let address = a["address"].as_str().unwrap_or("");
                if name.is_empty() {
                    address.into()
                } else {
                    format!("{name} <{address}>")
                }
            })
            .collect::<Vec<String>>()
            .join(", ")
    }
    let date = message["sentAt"]
        .as_str()
        .or_else(|| message["receivedAt"].as_str())
        .unwrap_or("");
    let date = DateTime::parse_from_rfc3339(date)
        .map(|d| crate::repository::timestamp(d.to_utc()))
        .unwrap_or_else(|_| date.to_owned());
    format!(
        "Subject: {}\nFrom: {}\nTo: {}\nCc: {}\nDate: {}\n\n{}",
        message["subject"].as_str().unwrap_or(""),
        addresses(&message["from"]),
        addresses(&message["to"]),
        addresses(&message["cc"]),
        date,
        message["textBody"].as_str().unwrap_or("")
    )
}

pub fn date(value: &Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|s| {
        DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.to_utc())
            .or_else(|| DateTime::parse_from_rfc2822(s).ok().map(|d| d.to_utc()))
    })
}

pub fn gmail_message(source: &Value, email: &str) -> Result<NormalizedMessage> {
    fn parts<'a>(p: &'a Value, output: &mut Vec<&'a Value>) {
        if !p.is_null() {
            output.push(p);
        }
        for child in p["parts"].as_array().into_iter().flatten() {
            parts(child, output);
        }
    }
    fn headers(p: &Value) -> HashMap<String, String> {
        p["headers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|h| {
                Some((
                    h["name"].as_str()?.to_lowercase(),
                    h["value"].as_str()?.to_owned(),
                ))
            })
            .collect()
    }
    let id = source["id"]
        .as_str()
        .context("Gmail returned a message without an id")?;
    let thread = source["threadId"]
        .as_str()
        .context("Gmail returned a message without an id")?;
    let headers = headers(&source["payload"]);
    let header = |name: &str| headers.get(name).map(String::as_str).unwrap_or("");
    let mut all = vec![];
    parts(&source["payload"], &mut all);
    let decode = |mime: &str| -> Result<Option<String>> {
        all.iter()
            .find(|p| p["mimeType"] == mime && p["body"]["data"].is_string())
            .map(|p| {
                let raw = p["body"]["data"].as_str().unwrap().trim_end_matches('=');
                Ok(String::from_utf8_lossy(&URL_SAFE_NO_PAD.decode(raw)?).into_owned())
            })
            .transpose()
    };
    let html_body = decode("text/html")?.map(|s| sanitize_email_html(&s));
    let text_body = decode("text/plain")?
        .unwrap_or_else(|| html_body.as_deref().map(text_from_html).unwrap_or_default());
    let labels: Vec<String> = source["labelIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let has = |s: &str| labels.iter().any(|l| l == s);
    let received = source["internalDate"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .and_then(DateTime::from_timestamp_millis)
        .unwrap_or_else(Utc::now);
    let from = parse_addresses(header("from"));
    let attachments = all.iter().filter(|p| p["filename"].as_str().is_some_and(|s| !s.is_empty()) && p["body"]["attachmentId"].is_string()).map(|p| {
        let h = p["headers"].as_array().into_iter().flatten().filter_map(|h| Some((h["name"].as_str()?.to_lowercase(),h["value"].as_str()?))).collect::<HashMap<_,_>>();
        json!({"id":p["body"]["attachmentId"],"filename":p["filename"],"contentType":p["mimeType"].as_str().unwrap_or("application/octet-stream"),"size":p["body"]["size"].as_u64().unwrap_or(0),"inline":h.get("content-disposition").is_some_and(|s| s.to_lowercase().starts_with("inline")),"contentId":h.get("content-id").map(|s| s.trim_matches(['<','>']))})
    }).collect::<Vec<_>>();
    Ok(NormalizedMessage {
        provider_message_id: id.into(),
        provider_thread_id: thread.into(),
        internet_message_id: headers.get("message-id").cloned(),
        subject: headers
            .get("subject")
            .cloned()
            .unwrap_or_else(|| "(no subject)".into()),
        direction: if has("SENT") || from.iter().any(|a| a.address == email.to_lowercase()) {
            "outbound"
        } else {
            "inbound"
        }
        .into(),
        from,
        to: parse_addresses(header("to")),
        cc: parse_addresses(header("cc")),
        bcc: parse_addresses(header("bcc")),
        sent_at: date(&json!(header("date"))),
        received_at: received,
        snippet: source["snippet"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| snippet(&text_body)),
        text_body,
        html_body,
        headers: json!(headers),
        attachments: json!(attachments),
        read: !has("UNREAD"),
        flagged: has("STARRED"),
        archived: !has("INBOX") && !has("SENT") && !has("TRASH"),
        deleted: has("TRASH"),
        tombstone: has("DRAFT"),
        containers: labels
            .iter()
            .map(|id| Container {
                id: id.clone(),
                name: id.clone(),
                kind: "label".into(),
            })
            .collect(),
        native_state: json!({"labelIds":labels,"historyId":source["historyId"]}),
        provider_updated_at: Some(received),
    })
}

pub fn graph_message(
    source: &Value,
    email: &str,
    folder_id: &str,
    folder_name: &str,
    sent_folder: &str,
    attachments: Value,
) -> Result<Option<NormalizedMessage>> {
    if source["@removed"].is_object() || !source["id"].is_string() || source["isDraft"] == true {
        return Ok(None);
    }
    let received = date(&source["receivedDateTime"]).or_else(|| date(&source["sentDateTime"]));
    ensure!(
        received.is_some(),
        "Microsoft message {} is missing its received and sent timestamps",
        source["id"].as_str().unwrap()
    );
    let addresses = |v: &Value| -> Vec<Address> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                Some(Address {
                    name: v["emailAddress"]["name"].as_str().unwrap_or("").into(),
                    address: v["emailAddress"]["address"].as_str()?.to_lowercase(),
                })
            })
            .collect()
    };
    let from = addresses(&json!([source["from"]]));
    let parent = source["parentFolderId"].as_str().unwrap_or(folder_id);
    let raw = source["body"]["content"].as_str().unwrap_or("");
    let html_body = source["body"]["contentType"]
        .as_str()
        .filter(|s| s.eq_ignore_ascii_case("html"))
        .map(|_| sanitize_email_html(raw));
    let text_body = html_body
        .as_deref()
        .map(text_from_html)
        .unwrap_or_else(|| raw.into());
    Ok(Some(NormalizedMessage {
        provider_message_id: source["id"].as_str().unwrap().into(),
        provider_thread_id: source["conversationId"]
            .as_str()
            .unwrap_or(source["id"].as_str().unwrap())
            .into(),
        internet_message_id: source["internetMessageId"].as_str().map(str::to_owned),
        subject: source["subject"].as_str().unwrap_or("(no subject)").into(),
        direction: if parent == sent_folder
            || from.iter().any(|a| a.address == email.to_lowercase())
        {
            "outbound"
        } else {
            "inbound"
        }
        .into(),
        from,
        to: addresses(&source["toRecipients"]),
        cc: addresses(&source["ccRecipients"]),
        bcc: addresses(&source["bccRecipients"]),
        sent_at: date(&source["sentDateTime"]),
        received_at: received.unwrap(),
        snippet: source["bodyPreview"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| snippet(&text_body)),
        text_body,
        html_body,
        headers: json!({}),
        attachments,
        read: source["isRead"].as_bool().unwrap_or(false),
        flagged: source["flag"]["flagStatus"] == "flagged",
        archived: folder_name.eq_ignore_ascii_case("archive"),
        deleted: folder_name.eq_ignore_ascii_case("deleted items")
            || folder_name.eq_ignore_ascii_case("trash"),
        tombstone: false,
        native_state: json!({"parentFolderId":source["parentFolderId"],"isDraft":source["isDraft"],"isSent":parent==sent_folder}),
        provider_updated_at: date(&source["lastModifiedDateTime"]).or(received),
        containers: vec![Container {
            id: parent.into(),
            name: folder_name.into(),
            kind: "folder".into(),
        }],
    }))
}
