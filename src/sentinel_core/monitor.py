"""Continuous multi-tenant email-monitoring loop.

One daemon iterates over every user in the database on each tick:
  - loads the user's mail accounts and per-user preferences
  - builds a notifier from their preferences (Telegram for now)
  - fetches new mail from each enabled account
  - classifies via the shared OpenAI client, passing the user's notes
  - notifies on IMPORTANT, no-ops otherwise
  - records processing in the per-user ledger

A single user's failure (bad OAuth, offline IMAP, classifier error) does
not halt the loop or affect other users — it's logged and the tick moves on.
"""

import signal
import time
from datetime import datetime, timedelta
from types import FrameType
from typing import Any, Dict, Optional

from sentinel_core.classifier.email_classifier import (
    ClassificationResult,
    EmailClassifier,
)
from sentinel_core.config import settings
from sentinel_core.database import EmailDatabase
from sentinel_core.streams.email.email_client_base import EmailClient
from sentinel_core.streams.email.email_client_factory import EmailClientFactory
from sentinel_core.streams.email.mail_config import MailboxesConfig
from sentinel_core.streams.email.models import EmailData
from sentinel_core.logging_config import get_logger
from sentinel_core.notify.email_notifier import EmailNotifier
from sentinel_core.notify.telegram_email_notifier import TelegramEmailNotifier
from sentinel_core.notify.telegram_notifier import TelegramNotifier
from sentinel_core.telegram_bot import start_in_thread as start_telegram_listener
from sentinel_core.user_settings import UserSettings

logger = get_logger("sentinel.monitor")


class EmailMonitor:
    """Top-level daemon. Iterates users and processes their mail on each tick."""

    def __init__(self, database: EmailDatabase):
        logger.info("Initializing EmailMonitor")
        self.db = database
        self.classifier = EmailClassifier()
        self.running = True

        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)

        logger.info("EmailMonitor initialization complete")

    def _signal_handler(self, signum: int, frame: Optional[FrameType]) -> None:
        logger.info(f"Received signal {signum}. Initiating graceful shutdown...")
        self.running = False

    def run(self) -> None:
        logger.info(
            "Starting Sentinel monitor: poll=%ss, max_lookback=%sh",
            settings.POLL_INTERVAL_SECONDS,
            settings.MAX_LOOKBACK_HOURS,
        )

        # Spawn the Telegram bot listener so /start <token> links land in
        # user_settings without a separate long-running process.
        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.DATABASE_PATH)
        else:
            logger.info(
                "TELEGRAM_BOT_TOKEN not set — skipping bot listener; "
                "Telegram linking will not work until it's configured"
            )

        while self.running:
            try:
                self._tick()
            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                logger.error(f"Unexpected error in monitor tick: {e}", exc_info=True)

            if self.running:
                time.sleep(settings.POLL_INTERVAL_SECONDS)

        logger.info("Monitor loop ended. Cleaning up...")
        self.db.close()
        logger.info("Monitor stopped successfully")

    def _tick(self) -> None:
        users = self.db.list_users()
        if not users:
            logger.debug("No users yet; skipping tick")
            return
        for user in users:
            try:
                self._process_user(user)
            except Exception as e:
                logger.error(
                    f"Error processing user_id={user['id']} ({user['email']}): {e}",
                    exc_info=True,
                )

    def _process_user(self, user: Dict[str, Any]) -> None:
        user_id = int(user["id"])
        user_settings = UserSettings.load(self.db, user_id)
        mailboxes = MailboxesConfig.from_db(self.db, user_id)
        enabled = mailboxes.get_enabled_accounts()
        if not enabled:
            logger.debug(f"user_id={user_id} has no enabled accounts")
            return

        notifier = self._build_notifier(user_settings)
        if notifier is None:
            logger.warning(
                f"user_id={user_id} ({user['email']}) has no notification channel configured; "
                "their mail will be classified but IMPORTANT alerts have nowhere to go"
            )

        last_check = self._initialize_monitoring(user_id)
        after_timestamp = self._clamp_to_max_lookback(last_check)

        for account_name, account_config in enabled.items():
            try:
                client = EmailClientFactory.create(
                    account_name, account_config, db=self.db, user_id=user_id
                )
                self._process_account(
                    user_id=user_id,
                    user_notes=user_settings.CLASSIFICATION_NOTES,
                    client=client,
                    notifier=notifier,
                    after_timestamp=after_timestamp,
                )
            except Exception as e:
                logger.warning(
                    f"Account '{account_name}' for user_id={user_id} failed: {e}",
                    exc_info=True,
                )

        self.db.update_last_check_time(user_id, datetime.now())

    def _build_notifier(self, user_settings: UserSettings) -> Optional[EmailNotifier]:
        if user_settings.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            return TelegramEmailNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,  # operator-shared bot
                    chat_id=user_settings.TELEGRAM_CHAT_ID,
                )
            )
        # Email-as-notification-channel (via Resend) to be wired up later;
        # for now Telegram is the only option.
        return None

    def _initialize_monitoring(self, user_id: int) -> datetime:
        monitoring_start = self.db.get_monitoring_start_time(user_id)
        if not monitoring_start:
            monitoring_start = datetime.now()
            self.db.set_monitoring_start_time(user_id, monitoring_start)
            logger.info(
                f"First tick for user_id={user_id}. Setting monitoring start to {monitoring_start}"
            )
        return self.db.get_last_check_time(user_id) or monitoring_start

    def _clamp_to_max_lookback(self, after_timestamp: datetime) -> datetime:
        max_lookback = datetime.now() - timedelta(hours=settings.MAX_LOOKBACK_HOURS)
        return max(after_timestamp, max_lookback)

    def _process_account(
        self,
        user_id: int,
        user_notes: str,
        client: EmailClient,
        notifier: Optional[EmailNotifier],
        after_timestamp: datetime,
    ) -> None:
        account_config = client.config
        process_unread = account_config.settings.process_only_unread

        try:
            emails = client.get_emails_after_timestamp(
                after_timestamp, unread_only=process_unread
            )
        except Exception as e:
            logger.error(
                f"Error fetching emails from {client.provider_type} (user_id={user_id}): {e}"
            )
            return

        new_emails = [
            email for email in emails if not self.db.is_email_processed(user_id, email.id)
        ]
        if not new_emails:
            return

        logger.info(
            f"user_id={user_id}: {len(new_emails)} new email(s) from {client.provider_type}"
        )
        for email in new_emails:
            self._process_email(user_id, user_notes, client, notifier, email)

    def _process_email(
        self,
        user_id: int,
        user_notes: str,
        client: EmailClient,
        notifier: Optional[EmailNotifier],
        email: EmailData,
    ) -> None:
        logger.info(
            f"Processing user_id={user_id} provider={email.provider} id={email.id} "
            f"from={email.sender[:60]} subject={email.subject[:60]!r}"
        )
        try:
            classification = self.classifier.classify_email(email, notes=user_notes)
            logger.info(
                f"  → {classification.priority.value.upper()}: {(classification.summary or '')[:100]}"
            )

            if classification.is_important() and notifier is not None:
                self._send_notification(notifier, email, classification)

            if not email.is_read:
                try:
                    client.mark_as_read(email.id)
                except Exception as e:
                    logger.warning(f"Failed to mark {email.id} as read: {e}")

            self.db.mark_email_processed(
                user_id=user_id,
                email_id=email.id,
                provider=email.provider,
                subject=email.subject,
                sender=email.sender,
            )
        except Exception as e:
            logger.error(f"Error processing email {email.id}: {e}", exc_info=True)
            # Record it anyway so we don't retry-loop on a broken message.
            try:
                self.db.mark_email_processed(
                    user_id=user_id,
                    email_id=email.id,
                    provider=email.provider,
                )
            except Exception as db_error:
                logger.error(f"Failed to mark email as processed: {db_error}")

    def _send_notification(
        self,
        notifier: EmailNotifier,
        email: EmailData,
        classification: ClassificationResult,
    ) -> None:
        try:
            message_id = notifier.notify(email, classification)
            if message_id:
                logger.info(f"Notification sent. Message ID: {message_id}")
            else:
                logger.warning("Notifier returned no message id (send likely failed)")
        except Exception as e:
            logger.error(f"Error sending notification: {e}")
