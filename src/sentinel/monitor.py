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
from sentinel.classifier import ClassificationResult, OpenAIItemClassifier
from sentinel.notify import NotifyResult, NotifyStatus, TelegramItemNotifier
from sentinel.item import Item
from sentinel.email.mail_config import MailAccountConfig
from sentinel.email.stream import EmailStream
from sentinel.config import settings
from sentinel.database import Database
from sentinel.telegram_bot import start_in_thread as start_telegram_listener

logger = get_logger("sentinel.monitor")

_RESTART_DELAY_SECONDS = 30
_STREAM_REFRESH_SECONDS = 30

# Global classification kill switch. When True, observed mail is recorded as an
# message but never sent to the LLM (no classification, no alerts). Per the
# product's locked design this is False — classification is always on.
_CLASSIFICATION_DISABLED = False

# Per-stream concurrency. Inbox polls return at most a handful of new messages
# per minute, so a small cap is plenty to overlap the LLM round-trips.
_PER_STREAM_CONCURRENCY = 8

# Bounded inline retry for transient Telegram delivery failures.
_NOTIFY_RETRY_ATTEMPTS = 3
_NOTIFY_RETRY_BASE_DELAY = 1.0


class Monitor:
    def __init__(
        self,
        database: Database,
    ):
        self.db = database
        self.classifier = OpenAIItemClassifier(
            api_key=settings.LLM_API_KEY or "",
            model=settings.LLM_MODEL,
            reasoning_effort=settings.LLM_REASONING_EFFORT,
        )
        self._shutdown = asyncio.Event()
        # Live registry of running stream tasks.  Hot-reload diffs this
        # against the DB snapshot every _STREAM_REFRESH_SECONDS.
        self._stream_tasks: Dict[str, asyncio.Task] = {}
        # (stream_type, config_json, user_id) per running stream — config drift
        # detection without re-parsing JSON every refresh. Must match the
        # signature built in _refresh_streams exactly, or every refresh would
        # see a "change" and pointlessly restart the stream.
        self._stream_config_sig: Dict[str, tuple[str, str, Optional[int]]] = {}

    async def run(self) -> None:
        logger.info("Starting Sentinel supervisor")
        self._install_signal_handlers()

        listener = None
        if settings.TELEGRAM_BOT_TOKEN:
            listener = start_telegram_listener(settings.require_database_url())

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
            if listener is not None:
                listener.stop()

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
            # user_id is part of the signature so reassigning ownership (e.g. a
            # stream that gains an owner) restarts the task and rebuilds the
            # pipeline — otherwise it keeps the stale owner and never notifies.
            sig = (row["stream_type"], row["config_json"], row.get("user_id"))
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
        self._stream_config_sig[name] = (row["stream_type"], row["config_json"], row.get("user_id"))

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
            on_token_refreshed=lambda token_json, name=row["name"]: self._persist_email_token(name, token_json),
        )

    def _persist_email_token(self, name: str, token_json: str) -> None:
        """Write a refreshed OAuth token back into the stream's stored config."""
        row = self.db.get_stream(name)
        if not row:
            return
        config = MailAccountConfig.model_validate_json(row["config_json"])
        config.auth.token_json = token_json
        self.db.upsert_stream(
            name, row["stream_type"], config.model_dump_json(), user_id=row.get("user_id")
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

                try:
                    async for item in stream.items():
                        if self._shutdown.is_set():
                            break
                        t = asyncio.create_task(_handle(item))
                        in_flight.add(t)
                        t.add_done_callback(in_flight.discard)

                    if in_flight:
                        await asyncio.gather(*in_flight, return_exceptions=True)
                finally:
                    # On cancellation (stream stopped/reconfigured) don't leave
                    # item tasks running detached — cancel whatever's left.
                    for t in in_flight:
                        t.cancel()
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

    The dedup ledger is the `message` table, and a row is written only once the
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

    async def _notify_with_retry(
        self, item: Item, classification: ClassificationResult
    ) -> "NotifyResult":
        """Send the alert, retrying a few times on transient (retryable)
        failures with exponential backoff. Only called when notifier is set."""
        assert self.notifier is not None
        delay = _NOTIFY_RETRY_BASE_DELAY
        result = await asyncio.to_thread(self.notifier.notify, item, classification)
        for _ in range(_NOTIFY_RETRY_ATTEMPTS - 1):
            if result.status != NotifyStatus.FAILED or not result.retryable:
                return result
            await asyncio.sleep(delay)
            delay *= 2
            result = await asyncio.to_thread(self.notifier.notify, item, classification)
        return result

    def _log_ctx(self, item: Item) -> str:
        """Stable key=value prefix so one item's journey is greppable across
        the pipeline's log lines."""
        stream = item.stream_name or "-"
        user = self.user_id if self.user_id is not None else "-"
        return f"item={item.id} stream={stream} user={user}"

    async def process(self, item: Item) -> bool:
        ctx = self._log_ctx(item)
        if await asyncio.to_thread(self.db.is_message_recorded, item.id):
            logger.debug("%s outcome=dedup_skip", ctx)
            return False

        if _CLASSIFICATION_DISABLED:
            await asyncio.to_thread(self._record_message, item)
            logger.info("%s outcome=classification_disabled", ctx)
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
                logger.warning("%s outcome=classify_retry error=%s", ctx, exc)
                return False
            # Permanent failure: record message + failure atomically so we stop retrying.
            await asyncio.to_thread(self._record_failure, item, str(exc))
            logger.error("%s outcome=classify_failed error=%s", ctx, exc)
            return False

        recorded = await asyncio.to_thread(self._record_classification, item, classification)
        if not recorded:
            # Another worker recorded this item between the dedup check and the
            # write; it's already accounted for, so don't notify twice.
            logger.info("%s outcome=dedup_skip race=write", ctx)
            return False

        priority = classification.priority.value
        if not classification.is_important():
            logger.info("%s outcome=classified priority=%s notify=n/a", ctx, priority)
            return True

        # Important: a missing alert here is the failure that started all this,
        # so every branch states whether we delivered and, if not, why.
        if self.notifier is None:
            reason = "telegram_not_configured" if not settings.TELEGRAM_BOT_TOKEN else "stream_has_no_owner"
            logger.warning(
                "%s outcome=classified priority=important notify=skipped reason=%s", ctx, reason
            )
            return True

        result = await self._notify_with_retry(item, classification)
        if result.status == NotifyStatus.SENT:
            logger.info(
                "%s outcome=classified priority=important notify=sent msg=%s", ctx, result.detail
            )
        elif result.status == NotifyStatus.SKIPPED:
            logger.warning(
                "%s outcome=classified priority=important notify=skipped reason=%s", ctx, result.detail
            )
        else:
            logger.error(
                "%s outcome=classified priority=important notify=failed detail=%s", ctx, result.detail
            )
        return True

    def _message_fields(self, item: Item) -> Dict[str, Any]:
        """The message-table columns derived from an item, shared by every write."""
        return dict(
            source_id=item.id,
            stream_name=item.stream_name,
            title=item.title or "(no title)",
            body=item.body or None,
            url=item.url,
            author=item.author or None,
            received_at=item.received_at,
            metadata=item.metadata or None,
        )

    def _record_message(self, item: Item) -> Optional[int]:
        """Message-only write for the classification-disabled path."""
        return self.db.insert_message(**self._message_fields(item))

    def _record_classification(
        self, item: Item, classification: ClassificationResult
    ) -> bool:
        """Atomically record the message + its classification. False ⇒ dedup race."""
        return self.db.record_classified_message(
            **self._message_fields(item),
            priority=classification.priority.value,
            summary=classification.summary,
            reasoning=classification.reasoning,
            model=settings.LLM_MODEL or "unknown",
        )

    def _record_failure(self, item: Item, error: str) -> bool:
        """Atomically record the message + a permanent-failure marker."""
        return self.db.record_failed_message(**self._message_fields(item), error=error)


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
