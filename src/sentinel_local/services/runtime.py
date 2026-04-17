"""Dashboard/runtime-query helpers for the local runtime."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sentinel_lib.time_utils import utc_now
from sentinel_local.database import LocalDatabase


class LocalRuntimeService:
    def __init__(self, db: LocalDatabase):
        self.db = db

    def dashboard_snapshot(self) -> Dict[str, Any]:
        last_check = self.db.get_last_check_time()
        return {
            "processed_count": self.db.get_processed_count(),
            "last_check": last_check,
            "monitoring_start": self.db.get_monitoring_start_time(),
            "recent": self.db.recent_processed_items(limit=25),
            "streams_count": len(self.db.list_streams()),
            "health": daemon_health(last_check),
        }


def daemon_health(last_check: Optional[datetime]) -> Dict[str, Any]:
    if last_check is None:
        return {"status": "never run", "ok": False}
    age_s = (utc_now() - last_check).total_seconds()
    threshold = max(3 * 60, 60)
    if age_s < threshold:
        return {"status": f"running (last check {int(age_s)}s ago)", "ok": True}
    return {"status": f"stale (last check {int(age_s)}s ago)", "ok": False}
