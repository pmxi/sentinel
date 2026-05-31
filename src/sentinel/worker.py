"""Headless supervisor entry point — the polling + classification worker.

`sentinel-worker` runs the monitor that polls every connected mailbox,
classifies new messages, and persists/fans out the results. In the hosted
deployment this runs as its own process alongside `sentinel-web`.
"""

from __future__ import annotations

import asyncio

from sentinel.config import settings
from sentinel.database import Database
from sentinel.monitor import Monitor


def main() -> None:
    settings.validate()
    db = Database(settings.require_database_url())
    asyncio.run(Monitor(db).run())


if __name__ == "__main__":
    main()
