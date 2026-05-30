"""Async supervisor that polls every connected inbox and classifies new mail."""

from __future__ import annotations

import asyncio
import signal
from typing import Any, Dict, Optional

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)

from sentinel.logging_config import get_logger
from sentinel.classifier import OpenAIItemClassifier
from sentinel.notify import TelegramItemNotifier
from sentinel.item import Item
from sentinel.email.mail_config import MailAccountConfig
from sentinel.email.stream import EmailStream
from sentinel.config import settings
from sentinel.database import Database
from sentinel.services.streams import StreamService
from sentinel.telegram_bot import start_in_thread as start_telegram_listener

logger = get_logger("sentinel.monitor")

_RESTART_DELAY_SECONDS = 30
_STREAM_REFRESH_SECONDS = 30

# Global classification kill switch. When True, observed mail is recorded as an
# event but never sent to the LLM (no classification, no alerts). Per the
# product's locked design this is False — classification is always on.
_CLASSIFICATION_DISABLED = False

# Per-stream concurrency. Inbox polls return at most a handful of new messages
# per minute, so a small cap is plenty to overlap the LLM round-trips.
_PER_STREAM_CONCURRENCY = 8


class Monitor:
    def __init__(
        self,
        database: Database,
    ):
        self.db = database
        self.stream_service = StreamService(database)
        self.classifier = OpenAIItemClassifier(
            api_key=settings.LLM_API_KEY or "",
            model=settings.LLM_MODEL,
            reasoning_effort=settings.LLM_REASONING_EFFORT,
        )
        self._shutdown = asyncio.Event()
        # Live registry of running stream tasks.  Hot-reload diffs this
        # against the DB snapshot every _STREAM_REFRESH_SECONDS.
        self._stream_tasks: Dict[str, asyncio.Task] = {}
        # (stream_type, config_json) per running stream — config drift
        # detection without re-parsing JSON every refresh.
        self._stream_config_sig: Dict[str, tuple[str, str]] = {}

    async def run(self) -> None:
        logger.info("Starting Sentinel supervisor")
        self._install_signal_handlers()

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.require_database_url())

        await self._refresh_streams(initial=True)

        refresh_task = asyncio.create_task(self._refresh_loop(), name="stream-refresh")
        try:
            await self._shutdown.wait()
        finally:
            refresh_task.cancel()
            try:
                await refresh_task
            except (asyncio.CancelledError, Exception):
                pass
            await self._cancel_all()

    async def _refresh_loop(self) -> None:
        """Periodically diff DB-configured streams against running tasks."""
        while not self._shutdown.is_set():
            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=_STREAM_REFRESH_SECONDS)
                return
            except asyncio.TimeoutError:
                pass
            try:
                await self._refresh_streams()
            except Exception as exc:
                logger.warning("stream refresh failed: %s", exc)

    async def _refresh_streams(self, initial: bool = False) -> None:
        rows = await asyncio.to_thread(self.db.list_streams)
        desired: Dict[str, Dict[str, Any]] = {r["name"]: r for r in rows}

        # Cancel tasks for streams that no longer exist.
        removed = [n for n in self._stream_tasks if n not in desired]
        for name in removed:
            await self._stop_stream(name, reason="removed from DB")

        added = 0
        updated = 0
        for name, row in desired.items():
            sig = (row["stream_type"], row["config_json"])
            running = self._stream_tasks.get(name)
            if running is None or running.done():
                self._start_stream(name, row)
                added += 1
                continue
            if self._stream_config_sig.get(name) != sig:
                await self._stop_stream(name, reason="config changed")
                self._start_stream(name, row)
                updated += 1

        if initial:
            logger.info("Supervising %d stream task(s)", len(self._stream_tasks))
        elif added or updated or removed:
            logger.info(
                "Stream refresh: +%d  ~%d  -%d  (running=%d)",
                added, updated, len(removed), len(self._stream_tasks),
            )

    def _start_stream(self, name: str, row: Dict[str, Any]) -> None:
        try:
            stream = self._build_stream(row)
        except Exception as exc:
            logger.error(
                "Failed to build stream %r (type=%s): %s",
                name, row["stream_type"], exc,
            )
            return
        task = asyncio.create_task(
            self._run_stream(stream, row.get("user_id")),
            name=f"stream:{name}",
        )
        self._stream_tasks[name] = task
        self._stream_config_sig[name] = (row["stream_type"], row["config_json"])

    async def _stop_stream(self, name: str, *, reason: str) -> None:
        task = self._stream_tasks.pop(name, None)
        self._stream_config_sig.pop(name, None)
        if task is None or task.done():
            return
        logger.info("Stopping stream %r (%s)", name, reason)
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    def _build_stream(self, row: Dict[str, Any]) -> EmailStream:
        config = MailAccountConfig.model_validate_json(row["config_json"])
        return EmailStream(
            name=row["name"],
            config=config,
            on_token_refreshed=lambda token_json, name=row["name"]: self.stream_service.persist_email_token(name, token_json),
        )

    async def _run_stream(self, stream: EmailStream, user_id: Optional[int]) -> None:
        while not self._shutdown.is_set():
            try:
                # Each inbox is processed with its owner's criteria + Telegram
                # target, both read live from the DB at point of use.
                pipeline = ItemPipeline(
                    db=self.db,
                    classifier=self.classifier,
                    user_id=user_id,
                )
                sem = asyncio.Semaphore(_PER_STREAM_CONCURRENCY)
                in_flight: set[asyncio.Task] = set()

                async def _handle(item: Item) -> None:
                    async with sem:
                        await pipeline.process(item)

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
                    "Stream %r crashed: %s. Restarting in %ss",
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
        logger.info("Received signal %s. Initiating shutdown.", sig)
        self._shutdown.set()

    async def _cancel_all(self) -> None:
        tasks = list(self._stream_tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._stream_tasks.clear()
        self._stream_config_sig.clear()


class ItemPipeline:
    """Per-user processing for one item: dedup → classify → record → notify.

    The dedup ledger is the `event` table, and a row is written only once the
    item reaches a terminal outcome (classified, or permanently failed). A
    transient classifier error therefore leaves no row, so the item is retried
    on the next poll instead of being silently swallowed.

    User state — classification criteria and Telegram chat_id — is read live
    from the DB at point of use, so linking Telegram or editing criteria takes
    effect on the owner's next item without restarting the worker.
    """

    def __init__(
        self,
        *,
        db: Database,
        classifier: OpenAIItemClassifier,
        user_id: Optional[int] = None,
    ):
        self.db = db
        self.user_id = user_id
        self.classifier = classifier
        # Per-user delivery: one shared Sentinel bot, the user's own chat_id,
        # resolved at send time (see _current_chat_id).
        self.notifier: Optional[TelegramItemNotifier] = None
        if settings.TELEGRAM_BOT_TOKEN and user_id is not None:
            self.notifier = TelegramItemNotifier(
                bot_token=settings.TELEGRAM_BOT_TOKEN,
                chat_id_provider=self._current_chat_id,
            )

    def _current_chat_id(self) -> Optional[str]:
        """Resolve the owner's Telegram chat_id now. Called at send time from a
        worker thread (sync DB read is fine there). None ⇒ not linked ⇒ skip."""
        if self.user_id is None:
            return None
        return (self.db.get_user(self.user_id) or {}).get("telegram_chat_id")

    async def process(self, item: Item) -> bool:
        if await asyncio.to_thread(self.db.is_item_processed, item.id):
            return False

        if _CLASSIFICATION_DISABLED:
            await asyncio.to_thread(self._record_event, item)
            return False

        notes = ""
        if self.user_id is not None:
            user = await asyncio.to_thread(self.db.get_user, self.user_id)
            notes = (user or {}).get("criteria") or ""

        try:
            classification = await self.classifier.classify(item, notes=notes)
        except Exception as exc:
            if _is_transient_classification_error(exc):
                # Leave no row — the item is retried on the next poll.
                logger.warning("transient classify error for %s; will retry: %s", item.id, exc)
                return False
            # Permanent failure: record the event + failure so we stop retrying.
            event_id = await asyncio.to_thread(self._record_event, item)
            if event_id is not None:
                await asyncio.to_thread(
                    self.db.insert_classification_failure, event_id, str(exc)
                )
            return False

        event_id = await asyncio.to_thread(self._record_event, item)
        if event_id is not None:
            await asyncio.to_thread(
                self.db.insert_classification,
                event_id=event_id,
                priority=classification.priority.value,
                summary=classification.summary,
                reasoning=classification.reasoning,
                model=settings.LLM_MODEL or "unknown",
            )
        if classification.is_important() and self.notifier is not None:
            await asyncio.to_thread(self.notifier.notify, item, classification)
        return True

    def _record_event(self, item: Item) -> Optional[int]:
        """Insert the event row (the dedup ledger). Returns its id, or None if
        the item_id already existed."""
        return self.db.insert_event(
            item_id=item.id,
            stream_name=(item.metadata or {}).get("stream_name", "") or "",
            title=item.title or "(no title)",
            body=item.body or None,
            url=item.url,
            author=item.author or None,
            received_at=item.received_at,
            metadata=_filter_metadata(item.metadata),
        )


# stream_name is already its own column; don't duplicate it inside metadata.
_RESERVED_METADATA_KEYS = {"stream_name"}


def _filter_metadata(md: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not md:
        return None
    out = {k: v for k, v in md.items() if k not in _RESERVED_METADATA_KEYS}
    return out or None


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
