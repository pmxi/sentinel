"""Async supervisor for the hosted multi-user runtime."""

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
from sentinel_hosted.config import settings
from sentinel_hosted.database import HostedDatabase
from sentinel_hosted.live_bus import LiveEvent, LiveEventBus
from sentinel_hosted.services.streams import HostedStreamService
from sentinel_hosted.telegram_bot import start_in_thread as start_telegram_listener
from sentinel_hosted.user_settings import UserSettings
from sentinel_lib import ItemProcessor, OpenAIItemClassifier, ProcessingEvent
from sentinel_lib.notify import TelegramItemNotifier, TelegramNotifier
from sentinel_lib.processing import ProcessingObserver, ProcessedItemStore
from sentinel_lib.streams import Item, Stream, build_stream, ensure_loaded
from sentinel_lib.time_utils import utc_now

logger = get_logger("sentinel.hosted.monitor")

_RESTART_DELAY_SECONDS = 30


class HostedMonitor:
    def __init__(
        self,
        database: HostedDatabase,
        bus: Optional[LiveEventBus] = None,
    ):
        ensure_loaded()
        self.db = database
        self.bus = bus
        self.stream_service = HostedStreamService(database)
        self.classifier = OpenAIItemClassifier(
            api_key=settings.LLM_API_KEY or "",
            model=settings.LLM_MODEL,
        )
        self._shutdown = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

    async def run(self) -> None:
        logger.info("Starting hosted Sentinel supervisor")
        self._install_signal_handlers()

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.DATABASE_PATH)

        users = await asyncio.to_thread(self.db.list_users)
        if not users:
            logger.warning("No hosted users exist yet; supervisor will idle")

        for user in users:
            await self._spawn_user_streams(user)

        if not self._tasks:
            logger.info("No hosted streams configured. Waiting for shutdown.")
        else:
            logger.info("Supervising %d hosted stream task(s)", len(self._tasks))
        await self._shutdown.wait()
        await self._cancel_all()

    async def _spawn_user_streams(self, user: Dict[str, Any]) -> None:
        user_id = int(user["id"])
        rows = await asyncio.to_thread(self.db.list_streams, user_id)
        if not rows:
            return
        if self.db.get_monitoring_start_time(user_id) is None:
            self.db.set_monitoring_start_time(user_id, utc_now())

        for row in rows:
            try:
                stream = self._build_stream(user_id, row)
            except Exception as exc:
                logger.error(
                    "Failed to build hosted stream %r for user_id=%s: %s",
                    row["name"],
                    user_id,
                    exc,
                )
                continue
            task = asyncio.create_task(
                self._run_stream(user_id, stream),
                name=f"hosted-stream:{user_id}:{row['name']}",
            )
            self._tasks.append(task)

    def _build_stream(self, user_id: int, row: Dict[str, Any]) -> Stream:
        extra: Dict[str, Any] = {}
        if row["stream_type"] == "email":
            extra["on_token_refreshed"] = (
                lambda token_json, uid=user_id, name=row["name"]:
                self.stream_service.persist_email_token(uid, name, token_json)
            )
        return build_stream(
            stream_type=row["stream_type"],
            name=row["name"],
            config_json=row["config_json"],
            **extra,
        )

    async def _run_stream(self, user_id: int, stream: Stream) -> None:
        while not self._shutdown.is_set():
            try:
                user_settings = await asyncio.to_thread(UserSettings.load, self.db, user_id)
                processor = HostedItemProcessor(
                    db=self.db,
                    classifier=self.classifier,
                    user_id=user_id,
                    user_settings=user_settings,
                    bus=self.bus,
                )
                async for item in stream.items():
                    if self._shutdown.is_set():
                        return
                    await processor.process(item)
                    await asyncio.to_thread(self.db.update_last_check_time, user_id, utc_now())
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception(
                    "Hosted stream %r (user_id=%s) crashed: %s. Restarting in %ss",
                    stream.name,
                    user_id,
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
        logger.info("Received signal %s. Initiating hosted shutdown.", sig)
        self._shutdown.set()

    async def _cancel_all(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


class HostedItemProcessor:
    def __init__(
        self,
        *,
        db: HostedDatabase,
        classifier: OpenAIItemClassifier,
        user_id: int,
        user_settings: UserSettings,
        bus: Optional[LiveEventBus],
    ):
        notifier = None
        if user_settings.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            notifier = TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=user_settings.TELEGRAM_CHAT_ID,
                )
            )
        self.processor = ItemProcessor(
            classifier=classifier,
            store=_HostedProcessedItemStore(db, user_id),
            notifier=notifier,
            observer=_HostedProcessingObserver(db, user_id, bus),
            is_retryable_classifier_error=_is_transient_classification_error,
        )
        self.notes = user_settings.CLASSIFICATION_NOTES

    async def process(self, item: Item) -> bool:
        return await self.processor.process(item, notes=self.notes)


class _HostedProcessedItemStore(ProcessedItemStore):
    def __init__(self, db: HostedDatabase, user_id: int):
        self.db = db
        self.user_id = user_id

    async def is_processed(self, item: Item) -> bool:
        return await asyncio.to_thread(
            self.db.is_item_processed,
            self.user_id,
            item.source_type,
            item.id,
        )

    async def mark_processed(self, item: Item) -> None:
        await asyncio.to_thread(
            self.db.mark_item_processed,
            self.user_id,
            item.source_type,
            item.id,
            item.title,
            item.author,
            str(item.metadata.get("stream_name", "")) if item.metadata else "",
        )


class _HostedProcessingObserver(ProcessingObserver):
    def __init__(self, db: HostedDatabase, user_id: int, bus: Optional[LiveEventBus]):
        self.db = db
        self.user_id = user_id
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
        event_id = self.db.emit_live_event(self.user_id, event.event_type, payload_json)
        if self.bus is not None:
            self.bus.publish(
                LiveEvent(
                    event_id=event_id,
                    user_id=self.user_id,
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
