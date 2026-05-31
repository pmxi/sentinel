"""EmailStream — drives the provider-specific email clients as an Item stream.

The clients (IMAP, Gmail) are the internal sync-fetch implementation; each one
already returns the pipeline's Item (see build_email_item). EmailStream wraps
them:

- runs a blocking fetch on a thread (the clients are sync)
- owns its own cursor (a datetime it's fetched past)

The mailbox is read-only; messages are never modified (e.g. marked read).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import AsyncIterator, Callable, List, Optional, Union

from sentinel.logging_config import get_logger
from sentinel.item import Item
from sentinel.email.gmail.client import GmailClient
from sentinel.email.imap_client import IMAPClient
from sentinel.email.mail_config import MailAccountConfig, MailProvider
from sentinel.time_utils import utc_now

logger = get_logger(__name__)

# The two concrete sync clients EmailStream drives. They share no base class —
# just a get_emails_after_timestamp()/close() shape, dispatched on provider.
EmailClient = Union[GmailClient, IMAPClient]


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
                items = await asyncio.to_thread(self._fetch_batch)
                for item in items:
                    self._advance_cursor(item.received_at)
                    yield item
            except Exception as e:
                logger.exception(
                    f"[{self.name}] email fetch failed: {e}"
                )

            await asyncio.sleep(_POLL_SECONDS)

    # ------------------------------------------------------------------ internals

    def _fetch_batch(self) -> List[Item]:
        """Blocking: fetch new emails as Items. Called via asyncio.to_thread."""
        client = _create_email_client(
            self.name,
            self.config,
            self.on_token_refreshed,
        )
        try:
            after = self._cursor or self._initial_cursor()
            items = client.get_emails_after_timestamp(
                after, unread_only=self.config.settings.process_only_unread
            )
            logger.debug(
                f"[{self.name}] fetched {len(items)} emails since {after.isoformat()}"
            )
            return items
        finally:
            client.close()

    def _initial_cursor(self) -> datetime:
        lookback = timedelta(hours=self.config.settings.max_lookback_hours)
        return utc_now() - lookback

    def _advance_cursor(self, when: datetime) -> None:
        if self._cursor is None or when > self._cursor:
            self._cursor = when
