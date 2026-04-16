import sys

from sentinel.classifier.email_classifier import EmailClassifier
from sentinel.config import settings
from sentinel.database import EmailDatabase
from sentinel.email.mail_config import MailboxesConfig
from sentinel.logging_config import get_logger
from sentinel.monitor import EmailMonitor
from sentinel.notify.telegram_email_notifier import TelegramEmailNotifier
from sentinel.notify.telegram_notifier import TelegramNotifier

logger = get_logger(__name__)


def main():
    """Run the email monitor daemon."""

    logger.info("Sentinel Email Monitor Starting")

    try:
        database = EmailDatabase(settings.DATABASE_PATH)

        logger.debug("Loading settings from database")
        settings.load(database)
        settings.validate()

        logger.info(f"Log level: {settings.LOG_LEVEL}")
        logger.info(f"Log directory: {settings.LOG_DIR}")

        logger.debug("Loading mailbox configuration from database")
        mailboxes_config = MailboxesConfig.from_db(database)
        if not mailboxes_config.get_enabled_accounts():
            raise ValueError(
                "No enabled mail accounts configured. Run 'sentinel account add'."
            )

        logger.debug("Initializing email classifier")
        classifier = EmailClassifier()

        if not settings.TELEGRAM_BOT_TOKEN or not settings.TELEGRAM_CHAT_ID:
            raise ValueError(
                "Telegram credentials not configured. Run 'sentinel init'."
            )

        notifier = TelegramNotifier(
            bot_token=settings.TELEGRAM_BOT_TOKEN,
            chat_id=settings.TELEGRAM_CHAT_ID,
        )
        email_notifier = TelegramEmailNotifier(notifier)

        monitor = EmailMonitor(mailboxes_config, classifier, email_notifier, database)
        monitor.run()

    except Exception as e:
        logger.critical(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

    logger.info("Sentinel Email Monitor shut down complete")
    sys.exit(0)


if __name__ == "__main__":
    main()
