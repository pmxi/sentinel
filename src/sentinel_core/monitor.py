"""Async supervisor that drives every user's every stream.

For each (user, stream) pair the supervisor spawns one asyncio task running
`async for item in stream.items(): ...`. Streams own their own cadence and
reconnect logic; the supervisor only handles classification, notification,
dedup, and restart-on-crash.

Signals: SIGINT / SIGTERM set a shutdown event and cancel all tasks.
"""

from __future__ import annotations

import asyncio
import json
import signal
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)

from sentinel_core.classifier import ClassificationResult, ItemClassifier
from sentinel_core.config import settings
from sentinel_core.live_bus import LiveEvent, LiveEventBus
from sentinel_core.logging_config import get_logger
from sentinel_core.notify.item_notifier import ItemNotifier
from sentinel_core.notify.telegram_item_notifier import TelegramItemNotifier
from sentinel_core.notify.telegram_notifier import TelegramNotifier
from sentinel_core.streams.base import Item, Stream
from sentinel_core.streams.registry import build_stream, ensure_loaded
from sentinel_core.telegram_bot import start_in_thread as start_telegram_listener
from sentinel_core.time_utils import utc_now
from sentinel_core.user_settings import UserSettings

if TYPE_CHECKING:
    from sentinel_core.database import EmailDatabase

logger = get_logger("sentinel.monitor")


# How long to wait before restarting a stream task that raised.
_RESTART_DELAY_SECONDS = 30


class Monitor:
    """Top-level async supervisor."""

    def __init__(
        self,
        database: "EmailDatabase",
        bus: Optional[LiveEventBus] = None,
    ):
        logger.info("Initializing Monitor")
        ensure_loaded()
        self.db = database
        self.classifier = ItemClassifier()
        self.bus = bus
        self._shutdown = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

    async def run(self) -> None:
        logger.info("Starting Sentinel supervisor")

        self._install_signal_handlers()

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.DATABASE_PATH)
        else:
            logger.info(
                "TELEGRAM_BOT_TOKEN not set — skipping bot listener; "
                "Telegram linking will not work until it's configured"
            )

        users = await asyncio.to_thread(self.db.list_users)
        if not users:
            logger.warning("No users yet; supervisor will idle until a user is added")

        for user in users:
            await self._spawn_user_streams(user)

        if not self._tasks:
            logger.info("No streams to run. Waiting for shutdown signal.")
            await self._shutdown.wait()
        else:
            logger.info(f"Supervising {len(self._tasks)} stream tasks")
            await self._shutdown.wait()

        await self._cancel_all()
        logger.info("Supervisor stopped successfully")

    # ------------------------------------------------------------------ spawn

    async def _spawn_user_streams(self, user: Dict[str, Any]) -> None:
        user_id = int(user["id"])
        rows = await asyncio.to_thread(self.db.list_streams, user_id)
        if not rows:
            logger.debug(f"user_id={user_id} ({user['email']}) has no streams")
            return

        await asyncio.to_thread(self._ensure_monitoring_start, user_id)

        for row in rows:
            try:
                stream = build_stream(
                    stream_type=row["stream_type"],
                    name=row["name"],
                    config_json=row["config_json"],
                    db=self.db,
                    user_id=user_id,
                )
            except Exception as e:
                logger.error(
                    f"Failed to build stream {row['name']!r} "
                    f"(type={row['stream_type']}) for user_id={user_id}: {e}"
                )
                continue
            task = asyncio.create_task(
                self._run_stream(user_id, stream),
                name=f"stream:{user_id}:{row['name']}",
            )
            self._tasks.append(task)

    def _ensure_monitoring_start(self, user_id: int) -> None:
        if self.db.get_monitoring_start_time(user_id) is None:
            self.db.set_monitoring_start_time(user_id, utc_now())

    async def _run_stream(self, user_id: int, stream: Stream) -> None:
        """Drive one stream. Restarts after a delay if items() raises."""
        while not self._shutdown.is_set():
            try:
                user_notes = await asyncio.to_thread(
                    self._load_user_notes, user_id
                )
                notifier = await asyncio.to_thread(
                    self._build_notifier, user_id
                )
                async for item in stream.items():
                    if self._shutdown.is_set():
                        return
                    await self._handle_item(user_id, user_notes, notifier, item)
                    await asyncio.to_thread(
                        self.db.update_last_check_time, user_id, utc_now()
                    )
                # Generator exited normally — stream is done (e.g. disabled).
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.exception(
                    f"Stream {stream.name!r} (user_id={user_id}) crashed: {e}. "
                    f"Restarting in {_RESTART_DELAY_SECONDS}s"
                )
                try:
                    await asyncio.wait_for(
                        self._shutdown.wait(), timeout=_RESTART_DELAY_SECONDS
                    )
                    return  # shutdown fired during the delay
                except asyncio.TimeoutError:
                    continue

    # ------------------------------------------------------------------ per-item

    async def _handle_item(
        self,
        user_id: int,
        user_notes: str,
        notifier: Optional[ItemNotifier],
        item: Item,
    ) -> None:
        already = await asyncio.to_thread(
            self.db.is_item_processed, user_id, item.source_type, item.id
        )
        if already:
            return

        logger.info(
            f"user_id={user_id} source={item.source_type} id={item.id} "
            f"author={item.author[:60]} title={item.title[:60]!r}"
        )

        await asyncio.to_thread(
            self._emit_event, user_id, "item_received", _item_event_payload(item)
        )

        should_mark_processed = False
        try:
            classification = await self.classifier.classify(item, notes=user_notes)
            logger.info(
                f"  → {classification.priority.value.upper()}: "
                f"{(classification.summary or '')[:100]}"
            )
            await asyncio.to_thread(
                self._emit_event,
                user_id,
                "item_classified",
                {
                    **_item_event_payload(item),
                    "priority": classification.priority.value,
                    "summary": classification.summary or "",
                    "reasoning": classification.reasoning,
                },
            )
            if classification.is_important() and notifier is not None:
                await self._send_notification(notifier, item, classification)
            should_mark_processed = True
        except Exception as e:
            logger.error(
                f"Error classifying item {item.source_type}/{item.id}: {e}",
                exc_info=True,
            )
            should_mark_processed = not _is_transient_classification_error(e)
            if not should_mark_processed:
                logger.info(
                    "Leaving item unprocessed so classification can retry: "
                    f"user_id={user_id} source={item.source_type} id={item.id}"
                )

        if not should_mark_processed:
            return

        try:
            await asyncio.to_thread(
                self.db.mark_item_processed,
                user_id,
                item.source_type,
                item.id,
                item.title,
                item.author,
                str(item.metadata.get("stream_name", "")) if item.metadata else "",
            )
        except Exception as e:
            logger.error(f"Failed to record processed item: {e}")

    async def _send_notification(
        self,
        notifier: ItemNotifier,
        item: Item,
        classification: ClassificationResult,
    ) -> None:
        try:
            message_id = await asyncio.to_thread(notifier.notify, item, classification)
            if message_id:
                logger.info(f"Notification sent. Message ID: {message_id}")
            else:
                logger.warning("Notifier returned no message id (send likely failed)")
        except Exception as e:
            logger.error(f"Error sending notification: {e}")

    # ------------------------------------------------------------------ helpers

    def _load_user_notes(self, user_id: int) -> str:
        s = UserSettings.load(self.db, user_id)
        return s.CLASSIFICATION_NOTES

    def _build_notifier(self, user_id: int) -> Optional[ItemNotifier]:
        s = UserSettings.load(self.db, user_id)
        if s.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            return TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=s.TELEGRAM_CHAT_ID,
                )
            )
        return None

    # ------------------------------------------------------------------ shutdown

    def _install_signal_handlers(self) -> None:
        import threading
        if threading.current_thread() is not threading.main_thread():
            # When the monitor runs in a background thread (embedded mode),
            # the main thread owns signals. Skip; the web process's signal
            # handler will tear us down via daemon=True exit.
            return
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self._request_shutdown, sig)
            except (NotImplementedError, RuntimeError):
                pass

    def _request_shutdown(self, sig: int) -> None:
        logger.info(f"Received signal {sig}. Initiating graceful shutdown...")
        self._shutdown.set()

    async def _cancel_all(self) -> None:
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def _emit_event(self, user_id: int, event_type: str, payload: Dict[str, Any]) -> None:
        try:
            payload_json = json.dumps(payload)
            event_id = self.db.emit_live_event(user_id, event_type, payload_json)
            if self.bus is not None:
                self.bus.publish(
                    LiveEvent(
                        event_id=event_id,
                        user_id=user_id,
                        event_type=event_type,
                        payload_json=payload_json,
                    )
                )
        except Exception as e:
            logger.warning(f"Failed to emit live event {event_type}: {e}")


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
