import sys

from src.monitor import EmailMonitor
from src.classifier.email_classifier import EmailClassifier
from src.config import settings
from src.database import EmailDatabase
from src.logging_config import get_logger
from src.email.mail_config import MailboxesConfig
from src.notify.telegram_notifier import TelegramNotifier
from src.notify.telegram_email_notifier import TelegramEmailNotifier

logger = get_logger(__name__)


def main():
    """Main entry point."""

    logger.info("Sentinel Email Monitor Starting")
    logger.info(f"Log level: {settings.LOG_LEVEL}")
    logger.info(f"Log directory: {settings.LOG_DIR}")

    try:
        # Validate configuration
        logger.debug("Validating configuration")
        settings.validate()
        logger.debug("Configuration validation successful")

        # Load mailbox configuration
        logger.debug("Loading mailbox configuration")
        mailboxes_config = MailboxesConfig.from_yaml()
        logger.debug("Mailbox configuration loaded successfully")

        # Initialize database
        logger.debug(f"Initializing database at {settings.DATABASE_PATH}")
        database = EmailDatabase(settings.DATABASE_PATH)
        logger.debug("Database initialized successfully")

        # Initialize classifier
        logger.debug("Initializing email classifier")
        classifier = EmailClassifier()
        logger.debug("Email classifier initialized successfully")

        # Initialize notifier
        logger.debug("Initializing Telegram notifier")
        
        if not settings.TELEGRAM_BOT_TOKEN or not settings.TELEGRAM_CHAT_ID:
            raise ValueError("Telegram credentials not configured. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.")
            
        notifier = TelegramNotifier(
            bot_token=settings.TELEGRAM_BOT_TOKEN,
            chat_id=settings.TELEGRAM_CHAT_ID
        )
        email_notifier = TelegramEmailNotifier(notifier)
        logger.debug("Telegram notifier initialized successfully")

        # Create and run monitor
        monitor = EmailMonitor(mailboxes_config, classifier, email_notifier, database)
        monitor.run()

    except Exception as e:
        logger.critical(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

    logger.info("Sentinel Email Monitor shut down complete")
    sys.exit(0)


if __name__ == "__main__":
    main()
