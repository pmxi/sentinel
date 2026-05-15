"""Hosted worker entrypoint."""

from __future__ import annotations

import asyncio
import sys

from sentinel.core.logging_config import get_logger
from sentinel.hosted.config import HostedSettings, settings
from sentinel.hosted.database import HostedDatabase
from sentinel.hosted.monitor import HostedMonitor

logger = get_logger(__name__)


def main() -> None:
    logger.info("Hosted Sentinel worker starting")
    try:
        with HostedDatabase(settings.DATABASE_PATH) as database:
            HostedSettings.load(database)
            HostedSettings.validate()
            asyncio.run(HostedMonitor(database).run())
    except Exception as exc:
        logger.critical("Fatal hosted worker error: %s", exc, exc_info=True)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
