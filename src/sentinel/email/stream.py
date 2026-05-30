"""EmailStream — adapts the provider-specific EmailClients to an Item stream.

The EmailClient hierarchy (IMAP, Gmail) stays as the internal sync-fetch
implementation. EmailStream wraps it:

- runs a blocking fetch on a thread (the clients are sync)
- converts EmailData → Item at the boundary, namespacing the item id by
  stream so ids from different inboxes can't collide in the dedup ledger
- owns its own cursor (a datetime it's fetched past)

The mailbox is read-only; messages are never modified (e.g. marked read).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import AsyncIterator, Callable, List, Optional

from sentinel.logging_config import get_logger
from sentinel.item import Item
from sentinel.email.email_client_base import EmailClient
from sentinel.email.gmail.client import GmailClient
from sentinel.email.imap_client import IMAPClient
from sentinel.email.mail_config import MailAccountConfig, MailProvider
from sentinel.email.models import EmailData
from sentinel.time_utils import ensure_utc, parse_iso_datetime, utc_now

logger = get_logger(__name__)


# How often the email stream re-checks the mailbox.
_POLL_SECONDS = 60


def _create_email_client(
    name: str,
    config: MailAccountConfig,
    on_token_refreshed: Optional[Callable[[str], None]],
) -> EmailClient:
    """Pick the client for a provider. The clients and the pydantic config
    models validate their own required fields, so there's nothing to check
    here beyond the provider."""
    if config.provider == MailProvider.GMAIL_API:
        return GmailClient(name, config, on_token_refreshed)
    if config.provider == MailProvider.IMAP:
        return IMAPClient(name, config)
    raise ValueError(f"Unsupported provider: {config.provider}")


class EmailStream:
    def __init__(
        self,
        name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        self.name = name
        self.config = config
        self.on_token_refreshed = on_token_refreshed
        self._cursor: datetime | None = None

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"EmailStream {self.name!r} is disabled; not starting")
            return

        # The first poll looks back max_lookback_hours; thereafter the in-memory
        # cursor advances past the newest message seen. Dedup (the event table)
        # makes re-fetches after a restart harmless.
        while True:
            try:
                emails = await asyncio.to_thread(self._fetch_batch)
                for email in emails:
                    item = _email_to_item(
                        email,
                        stream_name=self.name,
                        provider=self.config.provider,
                    )
                    self._advance_cursor(item.received_at)
                    yield item
            except Exception as e:
                logger.exception(
                    f"[{self.name}] email fetch failed: {e}"
                )

            await asyncio.sleep(_POLL_SECONDS)

    # ------------------------------------------------------------------ internals

    def _fetch_batch(self) -> List[EmailData]:
        """Blocking: fetch new emails. Called via asyncio.to_thread."""
        client = _create_email_client(
            self.name,
            self.config,
            self.on_token_refreshed,
        )
        try:
            after = self._cursor or self._initial_cursor()
            emails = client.get_emails_after_timestamp(
                after, unread_only=self.config.settings.process_only_unread
            )
            logger.debug(
                f"[{self.name}] fetched {len(emails)} emails since {after.isoformat()}"
            )
            return emails
        finally:
            client.close()

    def _initial_cursor(self) -> datetime:
        lookback = timedelta(hours=self.config.settings.max_lookback_hours)
        return utc_now() - lookback

    def _advance_cursor(self, when: datetime) -> None:
        if self._cursor is None or when > self._cursor:
            self._cursor = when


def _email_to_item(
    email: EmailData, *, stream_name: str, provider: str
) -> Item:
    received_at = _parse_received_date(email.received_date)
    rendered_body = (
        f"From: {email.sender}\n"
        f"To: {email.recipient}\n"
        f"Subject: {email.subject}\n"
        f"Date: {email.received_date}\n\n"
        f"{email.body}"
    )
    return Item(
        # Namespace by stream so message ids from different inboxes (e.g. two
        # IMAP accounts that both number a message "5") can't collide in the
        # globally-unique dedup ledger.
        id=f"{stream_name}:{email.id}",
        title=email.subject or "(no subject)",
        body=rendered_body,
        author=email.sender or "unknown sender",
        url=email.url,
        received_at=received_at,
        metadata={
            "provider": provider,
            "stream_name": stream_name,
            "recipient": email.recipient,
        },
    )


def _parse_received_date(date_str: str) -> datetime:
    if not date_str:
        return utc_now()
    try:
        return ensure_utc(parsedate_to_datetime(date_str))
    except (TypeError, ValueError):
        try:
            return parse_iso_datetime(date_str)
        except ValueError:
            return utc_now()
