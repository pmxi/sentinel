"""Synthetic local firehose for exercising the web UI.

This bypasses slow upstream publishers and LLM latency by writing dashboard-
compatible events directly into the local sqlite store at a configurable rate.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

from sentinel_lib.time_utils import utc_now
from sentinel_local.database import LocalDatabase

_TOPICS = (
    "Breaking market update",
    "Security advisory",
    "Infra latency spike",
    "Build pipeline status",
    "Competitive launch",
    "Customer escalation",
    "Regulatory filing",
    "Service health change",
)

_AUTHORS = (
    "Wire Desk",
    "Ops Watch",
    "Market Feed",
    "Build Monitor",
    "Incident Bot",
    "Release Radar",
)


@dataclass(frozen=True)
class FirehoseConfig:
    rate: float = 20.0
    count: int | None = 200
    source_type: str = "rss"
    stream_name: str = "dev-firehose"
    classify_delay_ms: int = 120
    important_every: int = 5


def run_firehose(db_path: str, config: FirehoseConfig) -> int:
    if config.rate <= 0:
        raise ValueError("rate must be greater than 0")
    if config.count is not None and config.count < 0:
        raise ValueError("count must be >= 0")
    if config.classify_delay_ms < 0:
        raise ValueError("classify_delay_ms must be >= 0")

    emitted = 0
    interval_seconds = 1.0 / config.rate

    with LocalDatabase(db_path) as db:
        if db.get_monitoring_start_time() is None:
            db.set_monitoring_start_time(utc_now())

        while config.count is None or emitted < config.count:
            started = time.perf_counter()
            item_number = emitted + 1
            payload = _item_payload(config, item_number)
            db.emit_live_event("item_received", json.dumps(payload))

            delay_seconds = min(config.classify_delay_ms / 1000.0, interval_seconds)
            if delay_seconds > 0:
                time.sleep(delay_seconds)

            classified_payload = dict(payload)
            priority = _priority_for(item_number, config.important_every)
            classified_payload.update(
                {
                    "priority": priority,
                    "summary": _summary_for(payload["title"], priority),
                    "reasoning": _reasoning_for(priority, config.source_type),
                }
            )
            db.emit_live_event("item_classified", json.dumps(classified_payload))
            db.mark_item_processed(
                config.source_type,
                payload["item_id"],
                payload["title"],
                payload["author"],
                config.stream_name,
            )
            db.update_last_check_time(utc_now())

            emitted += 1
            remaining = interval_seconds - (time.perf_counter() - started)
            if remaining > 0:
                time.sleep(remaining)

    return emitted


def _item_payload(config: FirehoseConfig, item_number: int) -> dict[str, str]:
    now = utc_now()
    topic = _TOPICS[(item_number - 1) % len(_TOPICS)]
    author = _AUTHORS[(item_number - 1) % len(_AUTHORS)]
    return {
        "source_type": config.source_type,
        "item_id": f"{config.stream_name}-{item_number:06d}",
        "title": f"{topic} #{item_number}",
        "author": author,
        "url": f"https://example.test/{config.stream_name}/{item_number}",
        "stream_name": config.stream_name,
        "received_at": now.isoformat(),
    }


def _priority_for(item_number: int, important_every: int) -> str:
    if important_every > 0 and item_number % important_every == 0:
        return "important"
    return "normal"


def _summary_for(title: str, priority: str) -> str:
    if priority == "important":
        return f"Escalate now: {title.lower()}."
    return f"Routine update: {title.lower()}."


def _reasoning_for(priority: str, source_type: str) -> str:
    if priority == "important":
        return f"Synthetic {source_type} item marked important for UI testing."
    return f"Synthetic {source_type} item marked normal for UI testing."
