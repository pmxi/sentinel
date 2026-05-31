"""EmailStream — drives the provider-specific email clients as a Message stream.

The clients (IMAP, Gmail) are the internal sync-fetch implementation; each one
already returns the pipeline's Message (see build_message). EmailStream wraps
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
from sentinel.message import Message
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

    async def messages(self) -> AsyncIterator[Message]:
        if not self.config.enabled:
            logger.info(f"EmailStream {self.name!r} is disabled; not starting")
            return

        # One client for the stream's lifetime: built once, reused across polls,
        # and rebuilt only after a fetch error (the connection may be stale).
        # Always closed when the stream stops. The first poll looks back
        # max_lookback_hours; thereafter the in-memory cursor advances past the
        # newest message seen. Dedup (the message table) makes re-fetches harmless.
        client: Optional[EmailClient] = None
        try:
            while True:
                try:
                    if client is None:
                        client = await asyncio.to_thread(
                            _create_email_client, self.name, self.config, self.on_token_refreshed
                        )
                    batch = await asyncio.to_thread(self._fetch_batch, client)
                    # Yield oldest-first so the cursor only advances past a
                    # message once it (and everything earlier) has been emitted;
                    # provider list order isn't guaranteed chronological.
                    for message in sorted(batch, key=lambda m: m.received_at):
                        self._advance_cursor(message.received_at)
                        yield message
                except Exception as e:
                    logger.exception(f"[{self.name}] email fetch failed: {e}")
                    # Drop the (possibly broken) client so the next poll rebuilds.
                    await asyncio.to_thread(self._close_client, client)
                    client = None

                await asyncio.sleep(_POLL_SECONDS)
        finally:
            await asyncio.to_thread(self._close_client, client)

    # ------------------------------------------------------------------ internals

    def _fetch_batch(self, client: EmailClient) -> List[Message]:
        """Blocking: fetch new emails as Messages. Called via asyncio.to_thread."""
        after = self._cursor or self._initial_cursor()
        messages = client.get_emails_after_timestamp(
            after, unread_only=self.config.settings.process_only_unread
        )
        logger.debug(
            f"[{self.name}] fetched {len(messages)} emails since {after.isoformat()}"
        )
        return messages

    def _close_client(self, client: Optional[EmailClient]) -> None:
        if client is None:
            return
        try:
            client.close()
        except Exception as e:
            logger.debug(f"[{self.name}] error closing client: {e}")

    def _initial_cursor(self) -> datetime:
        lookback = timedelta(hours=self.config.settings.max_lookback_hours)
        return utc_now() - lookback

    def _advance_cursor(self, when: datetime) -> None:
        if self._cursor is None or when > self._cursor:
            self._cursor = when
