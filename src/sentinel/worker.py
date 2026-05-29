"""Headless supervisor entry point — the polling + classification worker.

`sentinel-worker` runs the monitor that polls every connected mailbox,
classifies new items, and persists/fans out the results. In the hosted
deployment this runs as its own process alongside `sentinel-web`.
"""

from __future__ import annotations

import asyncio

from sentinel.config import settings
from sentinel.database import LocalDatabase
from sentinel.monitor import LocalMonitor


def main() -> None:
    settings.validate()
    db = LocalDatabase(settings.require_database_url())
    asyncio.run(LocalMonitor(db).run())


if __name__ == "__main__":
    main()
