"""Async supervisor for the local single-user runtime."""

from __future__ import annotations

import asyncio
import signal
import time
from typing import Any, Dict, List, Optional

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)

from sentinel.logging_config import get_logger
from sentinel.classifier import OpenAIItemClassifier
from sentinel.notify import TelegramItemNotifier, TelegramNotifier
from sentinel.processing import ItemProcessor, ProcessingEvent, ProcessingObserver, ProcessedItemStore
from sentinel.streams import Item
from sentinel.streams.email.mail_config import MailAccountConfig
from sentinel.streams.email.stream import EmailStream
from sentinel.config import settings
from sentinel.database import Database
from sentinel.services.streams import StreamService
from sentinel.telegram_bot import start_in_thread as start_telegram_listener
from sentinel.time_utils import utc_now

logger = get_logger("sentinel.monitor")

_RESTART_DELAY_SECONDS = 30
_STREAM_REFRESH_SECONDS = 30
# The event table is append-only and intentionally kept indefinitely — we
# never prune it. It grows fast under firehose traffic (~1k/s at full Tier-A
# scale), so capacity is managed at the infrastructure level (bigger volume,
# table partitioning, archiving), NOT by deleting history. Do not reintroduce
# a time-based prune here: a previous one silently failed for weeks, and
# "fixing" it would have deleted everything older than its cutoff.

# Global classification kill switch. When True, route everything through
# the no-LLM fast path (just emit item_received). Individual sources can
# still opt out per-item via item.metadata['skip_classification'] = True
# (BlueskyStream does this — too high-volume for per-item LLM calls).
_CLASSIFICATION_DISABLED = True


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
        # Throttle for the per-item liveness write to monitoring_state.
        # Without this, every emitted item at scale (50+/s across thousands
        # of streams) triggers a serialized DB upsert.
        self._last_check_ts_monotonic: float = 0.0
        self._last_check_min_interval_s: float = 5.0
        # One batching observer shared across every stream's processor.
        # The per-stream observer-per-processor pattern was a non-starter
        # at thousands of streams because each instance would run its own
        # batcher task and contend on the DB lock.
        self._observer: Optional[_BatchingObserver] = None

    async def run(self) -> None:
        logger.info("Starting local Sentinel supervisor")
        self._install_signal_handlers()

        # asyncio.to_thread uses the loop's default ThreadPoolExecutor which
        # caps at min(32, cpu+4) by default. At thousands of streams calling
        # to_thread for blocking OpenAI requests (~1-7s each), 32 workers
        # bottleneck the whole pipeline. Bump to 256 for headroom.
        import concurrent.futures
        loop = asyncio.get_running_loop()
        loop.set_default_executor(concurrent.futures.ThreadPoolExecutor(max_workers=256))
        logger.info("default executor sized to 256 workers")

        if settings.TELEGRAM_BOT_TOKEN:
            start_telegram_listener(settings.require_database_url())

        if self.db.get_monitoring_start_time() is None:
            self.db.set_monitoring_start_time(utc_now())

        await self._refresh_streams(initial=True)

        refresh_task = asyncio.create_task(self._refresh_loop(), name="stream-refresh")
        try:
            await self._shutdown.wait()
        finally:
            for t in (refresh_task,):
                t.cancel()
                try:
                    await t
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
            logger.info("Supervising %d local stream task(s)", len(self._stream_tasks))
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
            name=f"local-stream:{name}",
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
                # Process this inbox with its owner's criteria + notification target.
                user = self.db.get_user(user_id) if user_id is not None else None
                if self._observer is None:
                    self._observer = _BatchingObserver(self.db)
                processor = ItemPipeline(
                    db=self.db,
                    classifier=self.classifier,
                    observer=self._observer,
                    criteria=(user or {}).get("criteria") or "",
                    telegram_chat_id=(user or {}).get("telegram_chat_id"),
                )
                # Concurrency cap per stream. With many streams (700+),
                # 64-per-stream multiplied = 45k+ items potentially in-flight.
                # 8 is enough to overlap I/O without ballooning queue memory.
                sem = asyncio.Semaphore(8)
                in_flight: set[asyncio.Task] = set()

                async def _handle(item: Item) -> None:
                    async with sem:
                        try:
                            await processor.process(item)
                        finally:
                            # Coalesce monitoring_state.last_check_time writes.
                            # Skip on firehose items (skip_classification) and
                            # throttle the rest so high-rate streams don't
                            # serialize on the connection lock.
                            if not (item.metadata or {}).get("skip_classification"):
                                self._maybe_update_last_check_time()

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

    def _maybe_update_last_check_time(self) -> None:
        """Coalesce monitoring_state writes. Benign race across streams: the
        UPSERT is idempotent so duplicate writes within the window are
        harmless. Avoids one DB round-trip per emitted item."""
        now = time.monotonic()
        if now - self._last_check_ts_monotonic < self._last_check_min_interval_s:
            return
        self._last_check_ts_monotonic = now
        try:
            self.db.update_last_check_time(utc_now())
        except Exception as exc:
            logger.warning("update_last_check_time failed: %s", exc)

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
    def __init__(
        self,
        *,
        db: Database,
        classifier: OpenAIItemClassifier,
        observer: Optional["_BatchingObserver"] = None,
        criteria: str = "",
        telegram_chat_id: Optional[str] = None,
    ):
        # Per-user delivery: one shared Sentinel bot, the user's own chat_id.
        notifier = None
        if telegram_chat_id and settings.TELEGRAM_BOT_TOKEN:
            notifier = TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=str(telegram_chat_id),
                )
            )
        # Reuse a shared observer if provided (supervisor's batching writer);
        # otherwise build a private one (legacy callers).
        self.observer = observer or _BatchingObserver(db)
        self.processor = ItemProcessor(
            classifier=classifier,
            store=_DbProcessedItemStore(db),
            notifier=notifier,
            observer=self.observer,
            is_retryable_classifier_error=_is_transient_classification_error,
        )
        self.notes = criteria

    async def process(self, item: Item) -> bool:
        # Bypass when:
        # - the item's source is firehose-class (skip_classification), or
        # - the global kill switch is on (we're running headless w/o LLM).
        # In both cases just emit a received event for the dashboard.
        if _CLASSIFICATION_DISABLED or (item.metadata or {}).get("skip_classification"):
            await self.observer.publish(
                ProcessingEvent(event_type="item_received", item=item)
            )
            return False
        return await self.processor.process(item, notes=self.notes)


class _DbProcessedItemStore(ProcessedItemStore):
    """Dedup is now a UNIQUE constraint on `event(item_id)`.
    is_processed() is the existence check; mark_processed() is a no-op
    because the row already exists by the time we get here (the
    observer's batched insert is what created it)."""

    def __init__(self, db: Database):
        self.db = db

    async def is_processed(self, item: Item) -> bool:
        return await asyncio.to_thread(self.db.is_item_processed, item.id)

    async def mark_processed(self, item: Item) -> None:
        # No-op: event row already exists. We keep the method on the
        # Protocol because the shared ItemProcessor calls it after a
        # successful classification, but there's nothing to write here.
        return None


# Bluesky bodies often duplicate the title verbatim; storing both wastes
# space without information gain.
def _effective_body(item: Item) -> Optional[str]:
    body = (item.body or "").strip()
    title = (item.title or "").strip()
    if not body or body == title:
        return None
    return body


class _BatchingObserver(ProcessingObserver):
    """Async batched writer for event + classification.

    item_received  -> insert into event (also creates the dedup row)
    item_classified -> insert into classification
    item_failed     -> insert into classification_failure

    Item-received uses a batched multi-row INSERT through a 50k-bounded
    asyncio.Queue. Drops events on overflow rather than blocking the
    supervising stream tasks. Producers do not see back-pressure.

    Classifications are written one at a time — they're rare relative
    to the firehose, so batching them isn't worth the complexity.
    """

    BATCH_MAX = 500
    BATCH_INTERVAL_S = 0.25
    QUEUE_MAX = 50_000

    def __init__(self, db: Database):
        self.db = db
        self._queue: "asyncio.Queue[Item]" = asyncio.Queue(maxsize=self.QUEUE_MAX)
        self._task: Optional[asyncio.Task] = None
        self._dropped: int = 0
        self._last_dropped_log: float = 0.0

    def _ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._flush_loop(), name="event-batcher")

    async def publish(self, event: ProcessingEvent) -> None:
        """Dispatch by event_type. Only item_received enters the batched
        path; classification + failure write directly (low rate)."""
        self._ensure_started()
        if event.event_type == "item_received":
            try:
                self._queue.put_nowait(event.item)
            except asyncio.QueueFull:
                self._dropped += 1
                now = asyncio.get_running_loop().time()
                if now - self._last_dropped_log > 10:
                    logger.warning("event queue full; dropped %d so far", self._dropped)
                    self._last_dropped_log = now
        elif event.event_type == "item_classified" and event.classification is not None:
            await asyncio.to_thread(self._record_classification, event)
        elif event.event_type == "item_failed" and event.error:
            await asyncio.to_thread(self._record_failure, event)

    def _record_classification(self, ev: ProcessingEvent) -> None:
        # Look up the event_id by item_id. The earlier insert_event call
        # already established the row.
        with self.db._lock:
            row = self.db.conn.execute(
                "SELECT id FROM event WHERE item_id=%s",
                (ev.item.id,),
            ).fetchone()
        if not row:
            return  # the insert was dropped (e.g. dedup) — nothing to attach to
        event_id = int(row["id"])
        c = ev.classification
        if c is None:
            return
        self.db.insert_classification(
            event_id=event_id,
            priority=c.priority.value,
            summary=c.summary,
            reasoning=c.reasoning,
            model=_model_name_for_log(),
        )

    def _record_failure(self, ev: ProcessingEvent) -> None:
        with self.db._lock:
            row = self.db.conn.execute(
                "SELECT id FROM event WHERE item_id=%s",
                (ev.item.id,),
            ).fetchone()
        if not row:
            return
        self.db.insert_classification_failure(int(row["id"]), ev.error or "")

    async def _flush_loop(self) -> None:
        while True:
            try:
                batch = await self._drain_one_batch()
                if not batch:
                    continue
                rows = [
                    {
                        "item_id": item.id,
                        "stream_name": (item.metadata or {}).get("stream_name", "") or "",
                        "title": item.title or "(no title)",
                        "body": _effective_body(item),
                        "url": item.url,
                        "author": item.author or None,
                        "received_at": item.received_at,
                        "metadata": _filter_metadata(item.metadata),
                    }
                    for item in batch
                ]
                await asyncio.to_thread(self.db.insert_events_bulk, rows)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("event batch flush failed: %s", exc)
                await asyncio.sleep(0.5)

    async def _drain_one_batch(self) -> List[Item]:
        first = await self._queue.get()
        batch: List[Item] = [first]
        deadline = asyncio.get_running_loop().time() + self.BATCH_INTERVAL_S
        while len(batch) < self.BATCH_MAX:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                batch.append(await asyncio.wait_for(self._queue.get(), timeout=remaining))
            except asyncio.TimeoutError:
                break
        return batch


_RESERVED_METADATA_KEYS = {"stream_name", "skip_classification"}


def _filter_metadata(md: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not md:
        return None
    out = {k: v for k, v in md.items() if k not in _RESERVED_METADATA_KEYS}
    return out or None


def _model_name_for_log() -> str:
    return settings.LLM_MODEL or "unknown"


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
