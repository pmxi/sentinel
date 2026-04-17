"""Async supervisor for the local single-user runtime."""

from __future__ import annotations

import asyncio
import json
import signal
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
from sentinel_local.services.preferences import LocalPreferences
from sentinel_local.services.streams import LocalStreamService
from sentinel_local.telegram_bot import start_in_thread as start_telegram_listener
from sentinel_lib.time_utils import utc_now

logger = get_logger("sentinel.local.monitor")

_RESTART_DELAY_SECONDS = 30


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
        self._shutdown = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

    async def run(self) -> None:
        logger.info("Starting local Sentinel supervisor")
        self._install_signal_handlers()

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.DATABASE_PATH)

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
                )
                async for item in stream.items():
                    if self._shutdown.is_set():
                        return
                    await processor.process(item)
                    await asyncio.to_thread(self.db.update_last_check_time, utc_now())
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


class LocalItemProcessor:
    def __init__(
        self,
        *,
        db: LocalDatabase,
        classifier: OpenAIItemClassifier,
        preferences: LocalPreferences,
        bus: Optional[LiveEventBus],
    ):
        notifier = None
        if preferences.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            notifier = TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=preferences.TELEGRAM_CHAT_ID,
                )
            )
        self.processor = ItemProcessor(
            classifier=classifier,
            store=_LocalProcessedItemStore(db),
            notifier=notifier,
            observer=_LocalProcessingObserver(db, bus),
            is_retryable_classifier_error=_is_transient_classification_error,
        )
        self.notes = preferences.CLASSIFICATION_NOTES

    async def process(self, item: Item) -> bool:
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
        "author": item.author,
        "url": item.url,
        "stream_name": (item.metadata or {}).get("stream_name", ""),
        "received_at": item.received_at.isoformat() if item.received_at else None,
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
