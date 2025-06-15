"""Gmail-specific models and utilities."""

import base64

from src.email.models import EmailData


def extract_gmail_body(payload: dict) -> str:
    """Extract email body from Gmail message payload."""
    body = ""

    if "parts" in payload:
        for part in payload["parts"]:
            if part["mimeType"] == "text/plain":
                data = part["body"]["data"]
                body = base64.urlsafe_b64decode(data).decode("utf-8")
                break
    elif payload["mimeType"] == "text/plain":
        data = payload["body"]["data"]
        body = base64.urlsafe_b64decode(data).decode("utf-8")

    return body


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

    # Check if read
    is_read = "UNREAD" not in message.get("labelIds", [])

    return EmailData(
        id=message["id"],
        subject=subject,
        sender=sender,
        recipient=recipient,
        body=body,
        received_date=date,
        is_read=is_read,
        provider="gmail",
    )