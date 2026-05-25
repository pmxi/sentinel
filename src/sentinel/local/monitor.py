"""Async supervisor for the local single-user runtime."""

from __future__ import annotations

import asyncio
import json
import signal
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)

from sentinel.core.logging_config import get_logger
from sentinel.core import ItemProcessor, OpenAIItemClassifier, ProcessingEvent
from sentinel.core.notify import TelegramItemNotifier, TelegramNotifier
from sentinel.core.processing import ProcessingObserver, ProcessedItemStore
from sentinel.core.streams import Item, Stream, build_stream, ensure_loaded
from sentinel.local.config import settings
from sentinel.local.database import LocalDatabase
from sentinel.local.live_bus import LiveEvent, LiveEventBus
from sentinel.local.scorer import BatchScorer, LocalTextScorer
from sentinel.local.services.preferences import LocalPreferences
from sentinel.local.services.streams import LocalStreamService
from sentinel.local.telegram_bot import start_in_thread as start_telegram_listener
from sentinel.core.time_utils import utc_now

logger = get_logger("sentinel.local.monitor")

_RESTART_DELAY_SECONDS = 30
_STREAM_REFRESH_SECONDS = 30
# live_events is append-only and grows fast under firehose traffic
# (~1k/s at full Tier-A scale). Retention is hours, not days.
_LIVE_EVENTS_RETENTION_HOURS = 24
_LIVE_EVENTS_PRUNE_INTERVAL_S = 3600

# Global classification kill switch. When True, route everything through
# the no-LLM fast path (just emit item_received). Individual sources can
# still opt out per-item via item.metadata['skip_classification'] = True
# (BlueskyStream does this — too high-volume for per-item LLM calls).
_CLASSIFICATION_DISABLED = False


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
        # Shared preferences cache. With thousands of streams each calling
        # LocalPreferences.load() at startup, the supervisor would otherwise
        # serialize through the single DB connection for ~60s.
        self._preferences_cache: Optional[LocalPreferences] = None
        # One batching observer shared across every stream's processor.
        # The per-stream observer-per-processor pattern was a non-starter
        # at thousands of streams because each instance would run its own
        # batcher task and contend on the DB lock.
        self._observer: Optional[_LocalProcessingObserver] = None

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

        if self.scorer is not None:
            await self.scorer.start()

        if self.db.get_monitoring_start_time() is None:
            self.db.set_monitoring_start_time(utc_now())

        await self._refresh_streams(initial=True)

        refresh_task = asyncio.create_task(self._refresh_loop(), name="stream-refresh")
        prune_task = asyncio.create_task(self._prune_live_events_loop(), name="live-events-prune")
        try:
            await self._shutdown.wait()
        finally:
            for t in (refresh_task, prune_task):
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

    async def _prune_live_events_loop(self) -> None:
        """Keep live_events bounded — at high firehose rate the table will
        otherwise grow to tens of GB within hours and inserts collapse."""
        while not self._shutdown.is_set():
            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=_LIVE_EVENTS_PRUNE_INTERVAL_S)
                return
            except asyncio.TimeoutError:
                pass
            try:
                deleted = await asyncio.to_thread(
                    self.db.prune_live_events_older_than, _LIVE_EVENTS_RETENTION_HOURS
                )
                if deleted:
                    logger.info("pruned %d live_events older than %dh", deleted, _LIVE_EVENTS_RETENTION_HOURS)
            except Exception as exc:
                logger.warning("live_events prune failed: %s", exc)

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
            self._run_stream(stream),
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

    def _get_preferences(self) -> LocalPreferences:
        # Cached. Refreshes only on full supervisor restart; rare relative
        # to stream churn. (If you need live preference reloads, invalidate
        # this from the same callback that handles the settings update.)
        if self._preferences_cache is None:
            self._preferences_cache = LocalPreferences.load(self.db)
        return self._preferences_cache

    async def _run_stream(self, stream: Stream) -> None:
        while not self._shutdown.is_set():
            try:
                preferences = self._get_preferences()
                if self._observer is None:
                    self._observer = _LocalProcessingObserver(self.db, self.bus)
                processor = LocalItemProcessor(
                    db=self.db,
                    classifier=self.classifier,
                    preferences=preferences,
                    bus=self.bus,
                    scorer=self.scorer,
                    observer=self._observer,
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
        observer: Optional["_LocalProcessingObserver"] = None,
    ):
        notifier = None
        if preferences.has_telegram() and settings.TELEGRAM_BOT_TOKEN:
            notifier = TelegramItemNotifier(
                TelegramNotifier(
                    bot_token=settings.TELEGRAM_BOT_TOKEN,
                    chat_id=preferences.TELEGRAM_CHAT_ID,
                )
            )
        # Reuse a shared observer if provided (supervisor's batching writer);
        # otherwise build a private one (legacy callers).
        self.observer = observer or _LocalProcessingObserver(db, bus)
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
    """Async batching writer for live_events.

    Per-row INSERT through a single shared connection serializes through
    the connection lock and caps throughput at single-digit writes/sec
    once thousands of streams contend. We instead accept events into an
    asyncio.Queue, drain in batches of up to BATCH_MAX or every
    BATCH_INTERVAL_S, and flush via a single multi-row INSERT...VALUES
    RETURNING id call.

    The bus.publish step uses the DB-assigned id once the batch returns.
    """

    BATCH_MAX = 500
    BATCH_INTERVAL_S = 0.25
    # Bound the queue. At sustained high item rates, an unbounded queue
    # consumes memory faster than we can drain. We prefer dropping events
    # (with a log) over OOMing the supervisor.
    QUEUE_MAX = 50_000

    def __init__(self, db: LocalDatabase, bus: Optional[LiveEventBus]):
        self.db = db
        self.bus = bus
        self._queue: "asyncio.Queue[tuple[str, str]]" = asyncio.Queue(maxsize=self.QUEUE_MAX)
        self._task: Optional[asyncio.Task] = None
        self._dropped: int = 0
        self._last_dropped_log: float = 0.0

    def _ensure_started(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._flush_loop(), name="live-events-batcher")

    async def publish(self, event: ProcessingEvent) -> None:
        # Build the payload on the event-loop thread (no IO). Enqueue and
        # return immediately — DB writes happen in the background batcher.
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
        # Strip NUL chars from JSON output: Postgres jsonb rejects them
        # and some Bluesky posts include literal NUL bytes which propagate
        # through json.dumps as escaped sequences. Keeps later jsonb casts safe.
        payload_json = json.dumps(payload).replace("\\u0000", "")
        if chr(0) in payload_json:
            payload_json = payload_json.replace(chr(0), "")

        self._ensure_started()
        # Drop on overflow rather than block. Producers must not be
        # back-pressured — a blocked publish stalls the supervising stream
        # tasks and cascades. Log dropped counts at most once per 10s.
        try:
            self._queue.put_nowait((event.event_type, payload_json))
        except asyncio.QueueFull:
            self._dropped += 1
            now = asyncio.get_running_loop().time()
            if now - self._last_dropped_log > 10:
                logger.warning("live_events queue full; dropped %d events so far", self._dropped)
                self._last_dropped_log = now

    async def _flush_loop(self) -> None:
        while True:
            try:
                batch = await self._drain_one_batch()
                if not batch:
                    continue
                ids = await asyncio.to_thread(
                    self.db.emit_live_events_bulk, batch
                )
                if self.bus is not None:
                    for (event_type, payload_json), event_id in zip(batch, ids):
                        self.bus.publish(
                            LiveEvent(
                                event_id=event_id,
                                event_type=event_type,
                                payload_json=payload_json,
                            )
                        )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("live-events batch flush failed: %s", exc)
                await asyncio.sleep(0.5)

    async def _drain_one_batch(self) -> List[tuple[str, str]]:
        first = await self._queue.get()
        batch: List[tuple[str, str]] = [first]
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
