import sys

from sentinel_core.config import settings
from sentinel_core.database import EmailDatabase
from sentinel_core.logging_config import get_logger
from sentinel_core.monitor import EmailMonitor

logger = get_logger(__name__)


def main():
    """Run the email monitor daemon."""
    logger.info("Sentinel Email Monitor Starting")

    try:
        database = EmailDatabase(settings.DATABASE_PATH)
        settings.load(database)
        settings.validate()

        logger.info(f"Log level: {settings.LOG_LEVEL}")
        logger.info(f"Log directory: {settings.LOG_DIR}")

        monitor = EmailMonitor(database)
        monitor.run()

    except Exception as e:
        logger.critical(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

    logger.info("Sentinel Email Monitor shut down complete")
    sys.exit(0)


if __name__ == "__main__":
    main()
