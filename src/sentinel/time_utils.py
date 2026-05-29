"""Helpers for working with application timestamps in UTC."""

from __future__ import annotations

from datetime import UTC, datetime

_LOCAL_TZ = datetime.now().astimezone().tzinfo or UTC


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(UTC)


def ensure_utc(dt: datetime, *, assume_local: bool = False) -> datetime:
    """Normalize a datetime to timezone-aware UTC.

    `assume_local=True` is for legacy app timestamps that were previously
    written with naive local `datetime.now()`.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_LOCAL_TZ if assume_local else UTC)
    return dt.astimezone(UTC)


def parse_iso_datetime(raw: str, *, assume_local: bool = False) -> datetime:
    """Parse an ISO 8601 timestamp and normalize it to UTC."""
    dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    return ensure_utc(dt, assume_local=assume_local)


def format_iso_datetime(dt: datetime) -> str:
    """Serialize a datetime as an ISO 8601 UTC timestamp."""
    return ensure_utc(dt).isoformat().replace("+00:00", "Z")
