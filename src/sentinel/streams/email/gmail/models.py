"""Gmail-specific models and utilities."""

import base64

from sentinel.streams.email.models import EmailData


def extract_gmail_body(payload: dict) -> str:
    """Extract the text/plain body from a Gmail message payload.

    Recurses through nested MIME parts (e.g. multipart/mixed wrapping a
    multipart/alternative) and tolerates parts with no inline data, such as
    attachments. Returns "" if no text/plain part is found.
    """
    data = (payload.get("body") or {}).get("data")
    if payload.get("mimeType") == "text/plain" and data:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")

    for part in payload.get("parts") or []:
        text = extract_gmail_body(part)
        if text:
            return text

    return ""


def email_data_from_gmail_message(message: dict) -> EmailData:
    """Create EmailData from Gmail API message."""
    headers = message["payload"]["headers"]

    # Extract header information
    subject = next(
        (h["value"] for h in headers if h["name"] == "Subject"), "No Subject"
    )
    sender = next(
        (h["value"] for h in headers if h["name"] == "From"), "Unknown Sender"
    )
    recipient = next(
        (h["value"] for h in headers if h["name"] == "To"), "Unknown Recipient"
    )
    date = next(
        (h["value"] for h in headers if h["name"] == "Date"), "Unknown Date"
    )

    # Extract body
    body = extract_gmail_body(message["payload"])

    # Deep link into Gmail web UI; /u/0/ targets the user's primary Google account.
    thread_id = message.get("threadId")
    url = f"https://mail.google.com/mail/u/0/#inbox/{thread_id}" if thread_id else None

    return EmailData(
        id=message["id"],
        subject=subject,
        sender=sender,
        recipient=recipient,
        body=body,
        received_date=date,
        url=url,
    )
