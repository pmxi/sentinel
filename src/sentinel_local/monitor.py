"""Async supervisor for the local single-user runtime."""

from __future__ import annotations

import asyncio
import json
import signal
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)

from sentinel_lib.logging_config import get_logger
from sentinel_lib import ItemProcessor, OpenAIItemClassifier, ProcessingEvent
from sentinel_lib.notify import TelegramItemNotifier, TelegramNotifier
from sentinel_lib.processing import ProcessingObserver, ProcessedItemStore
from sentinel_lib.streams import Item, Stream, build_stream, ensure_loaded
from sentinel_local.config import settings
from sentinel_local.database import LocalDatabase
from sentinel_local.live_bus import LiveEvent, LiveEventBus
from sentinel_local.scorer import BatchScorer, LocalTextScorer
from sentinel_local.services.preferences import LocalPreferences
from sentinel_local.services.streams import LocalStreamService
from sentinel_local.telegram_bot import start_in_thread as start_telegram_listener
from sentinel_lib.time_utils import utc_now

logger = get_logger("sentinel.local.monitor")

_RESTART_DELAY_SECONDS = 30

# Temporary global kill switch: route every item through the no-LLM fast
# path, regardless of source. Flip to False (or delete) when classification
# is wired back in.
_CLASSIFICATION_DISABLED = True


class LocalMonitor:
    def __init__(
        self,
        database: LocalDatabase,
        bus: Optional[LiveEventBus] = None,
    ):
        ensure_loaded()
        self.db = database
        self.bus = bus
        self.stream_service = LocalStreamService(database)
        self.classifier = OpenAIItemClassifier(
            api_key=settings.LLM_API_KEY or "",
            model=settings.LLM_MODEL,
        )
        local_scorer = LocalTextScorer.maybe_load(Path("artifacts/classifier-v1.joblib"))
        self.scorer: Optional[BatchScorer] = (
            BatchScorer(local_scorer) if local_scorer is not None else None
        )
        self._shutdown = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

    async def run(self) -> None:
        logger.info("Starting local Sentinel supervisor")
        self._install_signal_handlers()

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.DATABASE_PATH)

        if self.scorer is not None:
            await self.scorer.start()

        if self.db.get_monitoring_start_time() is None:
            self.db.set_monitoring_start_time(utc_now())

        rows = await asyncio.to_thread(self.db.list_streams)
        for row in rows:
            try:
                stream = self._build_stream(row)
            except Exception as exc:
                logger.error(
                    "Failed to build stream %r (type=%s): %s",
                    row["name"],
                    row["stream_type"],
                    exc,
                )
                continue
            task = asyncio.create_task(
                self._run_stream(stream),
                name=f"local-stream:{row['name']}",
            )
            self._tasks.append(task)

        if not self._tasks:
            logger.info("No local streams configured. Waiting for shutdown signal.")
        else:
            logger.info("Supervising %d local stream task(s)", len(self._tasks))
        await self._shutdown.wait()
        await self._cancel_all()

    def _build_stream(self, row: Dict[str, Any]) -> Stream:
        extra: Dict[str, Any] = {}
        if row["stream_type"] == "email":
            extra["on_token_refreshed"] = lambda token_json, name=row["name"]: self.stream_service.persist_email_token(name, token_json)
        return build_stream(
            stream_type=row["stream_type"],
            name=row["name"],
            config_json=row["config_json"],
            **extra,
        )

    async def _run_stream(self, stream: Stream) -> None:
        while not self._shutdown.is_set():
            try:
                preferences = await asyncio.to_thread(LocalPreferences.load, self.db)
                processor = LocalItemProcessor(
                    db=self.db,
                    classifier=self.classifier,
                    preferences=preferences,
                    bus=self.bus,
                    scorer=self.scorer,
                )
                # Concurrency cap per stream. Without this the firehose
                # serializes on score()/process() and the BatchScorer
                # queue never accumulates enough to actually batch.
                sem = asyncio.Semaphore(64)
                in_flight: set[asyncio.Task] = set()

                async def _handle(item: Item) -> None:
                    async with sem:
                        try:
                            await processor.process(item)
                        finally:
                            # Skip the per-item liveness write for firehose
                            # streams; otherwise hundreds of writes/sec.
                            if not (item.metadata or {}).get("skip_classification"):
                                await asyncio.to_thread(self.db.update_last_check_time, utc_now())

                async for item in stream.items():
                    if self._shutdown.is_set():
                        break
                    t = asyncio.create_task(_handle(item))
                    in_flight.add(t)
                    t.add_done_callback(in_flight.discard)

                if in_flight:
                    await asyncio.gather(*in_flight, return_exceptions=True)
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(
                    "Local stream %r crashed: %s. Restarting in %ss",
                    stream.name,
                    exc,
                    _RESTART_DELAY_SECONDS,
                )
                try:
                    await asyncio.wait_for(
                        self._shutdown.wait(),
                        timeout=_RESTART_DELAY_SECONDS,
                    )
                    return
                except asyncio.TimeoutError:
                    continue

    def _install_signal_handlers(self) -> None:
        import threading

        if threading.current_thread() is not threading.main_thread():
            return
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._request_shutdown, sig)
            except (NotImplementedError, RuntimeError):
                pass

    def _request_shutdown(self, sig: int) -> None:
        logger.info("Received signal %s. Initiating local shutdown.", sig)
        self._shutdown.set()

    async def _cancel_all(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        if self.scorer is not None:
            await self.scorer.stop()


class LocalItemProcessor:
    def __init__(
        self,
        *,
        db: LocalDatabase,
        classifier: OpenAIItemClassifier,
        preferences: LocalPreferences,
        bus: Optional[LiveEventBus],
        scorer: Optional[BatchScorer] = None,
    ):
        notifier = None
        if preferences.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            notifier = TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=preferences.TELEGRAM_CHAT_ID,
                )
            )
        self.observer = _LocalProcessingObserver(db, bus)
        self.processor = ItemProcessor(
            classifier=classifier,
            store=_LocalProcessedItemStore(db),
            notifier=notifier,
            observer=self.observer,
            is_retryable_classifier_error=_is_transient_classification_error,
        )
        self.notes = preferences.CLASSIFICATION_NOTES
        self.scorer = scorer

    async def process(self, item: Item) -> bool:
        # Bypass when:
        # - the item's source is firehose-class (skip_classification), or
        # - the global kill switch is on (we're running headless w/o LLM).
        # In both cases just emit a received event for the dashboard.
        if _CLASSIFICATION_DISABLED or (item.metadata or {}).get("skip_classification"):
            if self.scorer is not None:
                try:
                    score = await self.scorer.score(item)
                    md = dict(item.metadata or {})
                    md["_classifier_score"] = score
                    item.metadata = md
                except Exception as exc:
                    logger.warning("scorer failed for %s: %s", item.id, exc)
            await self.observer.publish(
                ProcessingEvent(event_type="item_received", item=item)
            )
            return False
        return await self.processor.process(item, notes=self.notes)


class _LocalProcessedItemStore(ProcessedItemStore):
    def __init__(self, db: LocalDatabase):
        self.db = db

    async def is_processed(self, item: Item) -> bool:
        return await asyncio.to_thread(self.db.is_item_processed, item.source_type, item.id)

    async def mark_processed(self, item: Item) -> None:
        await asyncio.to_thread(
            self.db.mark_item_processed,
            item.source_type,
            item.id,
            item.title,
            item.author,
            str(item.metadata.get("stream_name", "")) if item.metadata else "",
        )


class _LocalProcessingObserver(ProcessingObserver):
    def __init__(self, db: LocalDatabase, bus: Optional[LiveEventBus]):
        self.db = db
        self.bus = bus

    async def publish(self, event: ProcessingEvent) -> None:
        await asyncio.to_thread(self._publish_sync, event)

    def _publish_sync(self, event: ProcessingEvent) -> None:
        payload = _item_event_payload(event.item)
        if event.classification is not None:
            payload.update(
                {
                    "priority": event.classification.priority.value,
                    "summary": event.classification.summary or "",
                    "reasoning": event.classification.reasoning,
                }
            )
        if event.error:
            payload["error"] = event.error

        payload_json = json.dumps(payload)
        event_id = self.db.emit_live_event(event.event_type, payload_json)
        if self.bus is not None:
            self.bus.publish(
                LiveEvent(
                    event_id=event_id,
                    event_type=event.event_type,
                    payload_json=payload_json,
                )
            )


def _item_event_payload(item: Item) -> Dict[str, Any]:
    return {
        "source_type": item.source_type,
        "item_id": item.id,
        "title": item.title,
        "body": item.body,
        "author": item.author,
        "url": item.url,
        "stream_name": (item.metadata or {}).get("stream_name", ""),
        "received_at": item.received_at.isoformat() if item.received_at else None,
        "score": (item.metadata or {}).get("_classifier_score"),
    }


def _is_transient_classification_error(exc: Exception) -> bool:
    if isinstance(
        exc,
        (APIConnectionError, APITimeoutError, RateLimitError, InternalServerError),
    ):
        return True
    if isinstance(exc, APIStatusError):
        status_code = getattr(exc, "status_code", None)
        return status_code in (408, 409, 429) or (
            isinstance(status_code, int) and status_code >= 500
        )
    return False
