import asyncio
import sys

from sentinel_core.config import Settings, settings
from sentinel_core.database import EmailDatabase
from sentinel_core.logging_config import get_logger
from sentinel_core.monitor import Monitor

logger = get_logger(__name__)


def main():
    """Run the Sentinel supervisor daemon."""
    logger.info("Sentinel Starting")

    try:
        with EmailDatabase(settings.DATABASE_PATH) as database:
            Settings.load(database)
            Settings.validate()

            logger.info(f"Log level: {Settings.LOG_LEVEL}")
            logger.info(f"Log directory: {Settings.LOG_DIR}")

            monitor = Monitor(database)
            asyncio.run(monitor.run())

    except Exception as e:
        logger.critical(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)

    logger.info("Sentinel shut down complete")
    sys.exit(0)


if __name__ == "__main__":
    main()
