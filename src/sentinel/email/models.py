"""Shared email models used across all email providers."""

from dataclasses import dataclass


@dataclass
class EmailData:
    """Email data model for all email providers."""

    id: str
    subject: str
    sender: str
    recipient: str
    body: str
    received_date: str
    is_read: bool
    provider: str  # Track which email provider this came from

    def __str__(self) -> str:
        """
        Convert this EmailData object to a plaintext format for LLM analysis.

        Returns:
            str: Formatted plaintext representation of the email

        Example output:
            From: sender@example.com
            To: recipient@example.com
            Subject: Important Meeting Tomorrow
            Date: Mon, 5 Jun 2025 10:30:00 -0700

            Hi John,

            Just wanted to remind you about our meeting tomorrow...
        """
        # Format the email in a clean, readable format
        text_parts: list[str] = []

        # Header information
        text_parts.append(f"From: {self.sender}")
        text_parts.append(f"To: {self.recipient}")
        text_parts.append(f"Subject: {self.subject}")
        text_parts.append(f"Date: {self.received_date}")
        text_parts.append("")  # Empty line separator

        # Email body
        text_parts.append(self.body)

        return "\n".join(text_parts)
