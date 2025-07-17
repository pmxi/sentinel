"""Continuous email monitoring script."""

import signal
import time
from datetime import datetime, timedelta
from types import FrameType
from typing import List, Optional

from sentinel.classifier.email_classifier import ClassificationResult, EmailClassifier
from sentinel.config import settings
from sentinel.database import EmailDatabase
from sentinel.email.email_client_base import EmailClient
from sentinel.email.email_client_factory import EmailClientFactory
from sentinel.email.gmail.models import EmailData
from sentinel.email.mail_config import MailAccountConfig, MailboxesConfig
from sentinel.logging_config import get_logger
from sentinel.notify.email_notifier import EmailNotifier


# Set up logger for this module
logger = get_logger("sentinel.monitor")


class EmailMonitor:
    db: EmailDatabase
    mail_config: MailboxesConfig
    classifier: EmailClassifier
    notifier: EmailNotifier
    email_clients: List[EmailClient]
    running: bool
    """Monitors all configured inboxes for new emails and processes them."""

    def __init__(
        self,
        mailboxes_config: MailboxesConfig,
        classifier: EmailClassifier,
        notifier: EmailNotifier,
        database: EmailDatabase,
    ):
        """Initialize the email monitor.

        Args:
            mailboxes_config: The mailbox configuration to use for monitoring.
            classifier: The email classifier to use for categorizing emails.
            notifier: The notifier to use for sending alerts about important emails.
            database: The database to use for tracking processed emails and monitoring state.
        """
        logger.info("Initializing EmailMonitor")
        self.running = True

        self.db = database
        self.mail_config = mailboxes_config
        self.classifier = classifier
        self.notifier = notifier

        logger.debug("Initializing email clients")
        try:
            self.email_clients: List[EmailClient] = []

            # Initialize clients for all enabled accounts
            for (
                account_name,
                account_config,
            ) in self.mail_config.get_enabled_accounts().items():
                try:
                    client = EmailClientFactory.create(account_name, account_config)
                    self.email_clients.append(client)
                    logger.info(
                        f"Initialized {account_config.provider} client for account '{account_name}'"
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to initialize client for account '{account_name}': {e}"
                    )

            # This is true if email_clients is empty.
            if not self.email_clients:
                raise Exception("No email clients could be initialized")

            # Set up signal handler for graceful shutdown
            signal.signal(signal.SIGINT, self._signal_handler)
            signal.signal(signal.SIGTERM, self._signal_handler)

            logger.info("EmailMonitor initialization complete")

        except Exception as e:
            logger.critical(f"Failed to initialize EmailMonitor: {e}", exc_info=True)
            raise

    def _signal_handler(self, signum: int, frame: Optional[FrameType]) -> None:
        """Handle shutdown signals gracefully."""
        logger.info(f"Received signal {signum}. Initiating graceful shutdown...")
        self.running = False

    def _initialize_monitoring(self) -> datetime:
        """Initialize monitoring timestamps and return the last check time."""
        # Initialize monitoring start time if this is the first run
        monitoring_start = self.db.get_monitoring_start_time()
        if not monitoring_start:
            monitoring_start = datetime.now()
            self.db.set_monitoring_start_time(monitoring_start)
            logger.info(
                f"First run detected. Setting monitoring start time to {monitoring_start}"
            )
            logger.info("Will only process emails received after this timestamp")
        else:
            logger.info(f"Resuming monitoring. Original start time: {monitoring_start}")

        # Get the last check time or use monitoring start time
        last_check = self.db.get_last_check_time() or monitoring_start
        logger.info(f"Last check timestamp: {last_check}")

        processed_count = self.db.get_processed_count()
        logger.info(f"Total emails processed in previous runs: {processed_count}")

        return last_check

    def run(self) -> None:
        """Main monitoring loop."""
        logger.info("Starting Sentinel Email Monitor")
        logger.info(
            f"Configuration: poll_interval={settings.POLL_INTERVAL_SECONDS}s, "
            f"process_only_unread={settings.PROCESS_ONLY_UNREAD}, "
            f"max_lookback={settings.MAX_LOOKBACK_HOURS}h"
        )

        last_check = self._initialize_monitoring()
        logger.debug("Entering main monitoring loop")

        while self.running:
            try:
                self._check_and_process_emails(last_check)

                # Update last check time
                last_check = datetime.now()
                self.db.update_last_check_time(last_check)
                logger.debug(f"Updated last check time to {last_check}")

                if self.running:
                    logger.debug(
                        f"Sleeping for {settings.POLL_INTERVAL_SECONDS} seconds"
                    )
                    time.sleep(settings.POLL_INTERVAL_SECONDS)

            except KeyboardInterrupt:
                logger.info("Keyboard interrupt received")
                break
            except Exception as e:
                logger.error(f"Unexpected error in monitoring loop: {e}", exc_info=True)
                if self.running:
                    logger.warning(
                        f"Will retry in {settings.POLL_INTERVAL_SECONDS} seconds"
                    )
                    time.sleep(settings.POLL_INTERVAL_SECONDS)

        logger.info("Monitoring loop ended. Cleaning up...")
        self.db.close()
        logger.info("Monitor stopped successfully")

    def _check_and_process_emails(self, after_timestamp: datetime) -> int:
        """Check for new emails and process them.

        Returns:
            Number of emails processed
        """
        # Apply max lookback limit
        max_lookback = datetime.now() - timedelta(hours=settings.MAX_LOOKBACK_HOURS)
        if after_timestamp < max_lookback:
            logger.debug(
                f"Adjusting timestamp from {after_timestamp} to max lookback {max_lookback}"
            )
            after_timestamp = max_lookback

        logger.info(f"Checking for new emails after {after_timestamp}")

        try:
            processed_count = 0
            total_new_emails = 0

            # Process emails grouped by client
            for client in self.email_clients:
                emails = self._fetch_emails_from_client(client, after_timestamp)

                # Filter out already processed emails
                new_emails = [
                    email
                    for email in emails
                    if not self.db.is_email_processed(email.id)
                ]

                if new_emails:
                    logger.info(
                        f"Found {len(new_emails)} new email(s) from {client.provider_type}"
                    )
                    total_new_emails += len(new_emails)

                    for email in new_emails:
                        if self._process_email(client, email):
                            processed_count += 1

            if total_new_emails == 0:
                logger.info("No new emails to process")
            else:
                logger.info(
                    f"Successfully processed {processed_count}/{total_new_emails} emails"
                )

            return processed_count

        except Exception as e:
            logger.error(f"Error checking/processing emails: {e}", exc_info=True)
            return 0

    def _process_email(self, client: EmailClient, email: EmailData) -> bool:
        """Process a single email.

        Returns:
            True if successfully processed, False otherwise
        """
        logger.info(
            f"Processing email: provider={email.provider}, id={email.id}, "
            f"from={email.sender}, subject={email.subject[:50]}..."
        )
        logger.debug(
            f"Email details: date={email.received_date}, body_preview={email.body[:100] if email.body else 'No body'}..."
        )

        try:
            # Classify the email
            logger.debug("Starting email classification")
            classification = self.classifier.classify_email(email)
            summary = classification.summary or "No summary available"
            logger.info(f"Classification complete. Summary: {summary[:100]}...")
            logger.debug(f"Full classification result: {classification}")

            # Take action based on classification
            if classification.priority.value == "junk":
                logger.info("Email classified as JUNK. Moving to junk folder...")
                try:
                    client.move_to_junk(email.id)
                    logger.info("Email moved to junk folder")
                except Exception as e:
                    logger.error(f"Failed to move email to junk: {e}")

            elif classification.is_important():
                logger.info("Email classified as IMPORTANT. Sending notification...")
                self._send_notification(email, classification)

            else:
                logger.info(
                    f"Email classified as {classification.priority.value.upper()}. No action needed."
                )

            # Mark as read after processing (if enabled)
            if not email.is_read:
                try:
                    client.mark_as_read(email.id)
                    logger.debug(f"Marked email {email.id} as read")
                except Exception as e:
                    logger.warning(f"Failed to mark email as read: {e}")

            # Mark as processed regardless of notification status
            logger.debug(f"Marking email {email.id} as processed in database")
            self.db.mark_email_processed(
                email.id,
                provider=email.provider,
                subject=email.subject,
                sender=email.sender,
            )
            logger.info(f"Email {email.id} successfully processed and recorded")
            return True

        except Exception as e:
            logger.error(f"Error processing email {email.id}: {e}", exc_info=True)

            # Still mark as processed to avoid retry loops
            try:
                logger.warning(
                    f"Marking email {email.id} as processed despite error to avoid retry loops"
                )
                self.db.mark_email_processed(email.id, provider=email.provider)
            except Exception as db_error:
                logger.error(
                    f"Failed to mark email as processed: {db_error}", exc_info=True
                )

            return False

    def _get_account_config(self, account_name: str) -> Optional[MailAccountConfig]:
        """Get account configuration by account name."""
        return self.mail_config.accounts.get(account_name)

    def _fetch_emails_from_client(
        self, client: EmailClient, after_timestamp: datetime
    ) -> List[EmailData]:
        """Fetch emails from a single client."""
        # Get account-specific settings
        account_config = self._get_account_config(client.account_name)
        process_unread = (
            account_config.settings.process_only_unread
            if account_config
            else settings.PROCESS_ONLY_UNREAD
        )

        logger.debug(
            f"Fetching emails from {client.provider_type} with params: "
            f"after_timestamp={after_timestamp}, unread_only={process_unread}"
        )

        try:
            client_emails = client.get_emails_after_timestamp(
                after_timestamp, unread_only=process_unread
            )
            logger.debug(f"{client.provider_type} returned {len(client_emails)} emails")
            return client_emails
        except Exception as e:
            logger.error(f"Error fetching emails from {client.provider_type}: {e}")
            return []

    def _send_notification(
        self, email: EmailData, classification: ClassificationResult
    ) -> None:
        """Send notification for an important email."""
        try:
            message_id = self.notifier.notify(email, classification)

            if message_id:
                logger.info(f"Notification sent successfully. Message ID: {message_id}")
            else:
                logger.warning("Failed to send notification for important email")
        except Exception as e:
            logger.error(f"Error sending notification: {e}")
