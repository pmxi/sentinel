"""Shared email models used across all email providers."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class EmailData:
    """Email data model for all email providers."""

    id: str
    subject: str
    sender: str
    recipient: str
    body: str
    received_date: str
    url: Optional[str] = None  # Deep link into the provider's UI, if available
