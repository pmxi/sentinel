"""EmailStream — adapts the provider-specific EmailClients to the Stream ABC.

The EmailClient hierarchy (IMAP, Gmail, MSGraph) stays as the internal
sync-fetch implementation. EmailStream wraps it:

- runs a blocking fetch on a thread (IMAP / Gmail / MSGraph are sync)
- converts EmailData → Item at the boundary
- owns its own cursor (a datetime it's fetched past)
- marks processed messages as read on the remote mailbox
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import AsyncIterator, Callable, List, Optional

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item, Stream
from sentinel_lib.streams.email.email_client_factory import EmailClientFactory
from sentinel_lib.streams.email.mail_config import MailAccountConfig
from sentinel_lib.streams.email.models import EmailData
from sentinel_lib.time_utils import ensure_utc, parse_iso_datetime, utc_now

logger = get_logger(__name__)


# How often the email stream re-checks the mailbox. Operator-overridable
# in the account config; 60s is a sensible default for IMAP/Gmail.
_DEFAULT_POLL_SECONDS = 60


class EmailStream(Stream):
    source_type = "email"

    def __init__(
        self,
        name: str,
        config: MailAccountConfig,
        on_token_refreshed: Optional[Callable[[str], None]] = None,
    ):
        super().__init__(name=name)
        self.config = config
        self.on_token_refreshed = on_token_refreshed
        self._cursor: datetime | None = None

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"EmailStream {self.name!r} is disabled; not starting")
            return

        poll_seconds = _DEFAULT_POLL_SECONDS

        # First cursor: now - max_lookback_hours (bounded by the monitor's
        # stored last-check timestamp, filled in by the supervisor when it
        # starts this stream's task).
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
                    if not email.is_read:
                        try:
                            await asyncio.to_thread(self._mark_remote_as_read, email.id)
                        except Exception as e:
                            logger.warning(
                                f"[{self.name}] failed to mark {email.id} as read: {e}"
                            )
            except Exception as e:
                logger.exception(
                    f"[{self.name}] email fetch failed: {e}"
                )

            await asyncio.sleep(poll_seconds)

    # ------------------------------------------------------------------ internals

    def _fetch_batch(self) -> List[EmailData]:
        """Blocking: fetch new emails. Called via asyncio.to_thread."""
        client = EmailClientFactory.create(
            self.name,
            self.config,
            on_token_refreshed=self.on_token_refreshed,
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

    def _mark_remote_as_read(self, email_id: str) -> None:
        client = EmailClientFactory.create(
            self.name,
            self.config,
            on_token_refreshed=self.on_token_refreshed,
        )
        try:
            client.mark_as_read(email_id)
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
        id=email.id,
        source_type="email",
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
