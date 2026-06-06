"""Helpers for working with application timestamps in UTC."""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(UTC)


def ensure_utc(dt: datetime) -> datetime:
    """Normalize a datetime to timezone-aware UTC (naive inputs are treated as UTC)."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def parse_iso_datetime(raw: str) -> datetime:
    """Parse an ISO 8601 timestamp and normalize it to UTC."""
    dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    return ensure_utc(dt)
