"""Async supervisor that polls every connected inbox and classifies new mail."""

from __future__ import annotations

import asyncio
import contextlib
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
from sentinel.classifier import ClassificationResult, OpenAIMessageClassifier
from sentinel.notify import NotifyResult, NotifyStatus, WebPushNotifier
from sentinel.message import Message
from sentinel.email.mail_config import MailAccountConfig
from sentinel.email.stream import EmailStream
from sentinel.config import settings
from sentinel.database import Database

logger = get_logger("sentinel.monitor")

_RESTART_DELAY_SECONDS = 30
_STREAM_REFRESH_SECONDS = 30

# Per-stream concurrency. Inbox polls return at most a handful of new messages
# per minute, so a small cap is plenty to overlap the LLM round-trips.
_PER_STREAM_CONCURRENCY = 8

# Bounded inline retry for transient Web Push delivery failures.
_NOTIFY_RETRY_ATTEMPTS = 3
_NOTIFY_RETRY_BASE_DELAY = 1.0


async def _drain(task: asyncio.Task) -> None:
    """Cancel a task and wait for it to settle, ignoring whatever it raises
    during teardown."""
    task.cancel()
    with contextlib.suppress(BaseException):
        await task


class Monitor:
    def __init__(
        self,
        database: Database,
    ):
        self.db = database
        self.classifier = OpenAIMessageClassifier(
            api_key=settings.LLM_API_KEY or "",
            model=settings.LLM_MODEL,
            reasoning_effort=settings.LLM_REASONING_EFFORT,
        )
        self._shutdown = asyncio.Event()
        # Live registry of running stream tasks.  Hot-reload diffs this
        # against the DB snapshot every _STREAM_REFRESH_SECONDS.
        self._stream_tasks: Dict[str, asyncio.Task] = {}
        # (config_json, user_id) per running stream — config drift detection
        # without re-parsing JSON every refresh. Must match the signature built
        # in _refresh_streams exactly, or every refresh would see a "change" and
        # pointlessly restart the stream.
        self._stream_config_sig: Dict[str, tuple[str, Optional[int]]] = {}

    async def run(self) -> None:
        logger.info("Starting Sentinel supervisor")
        self._install_signal_handlers()

        await self._refresh_streams(initial=True)

        refresh_task = asyncio.create_task(self._refresh_loop(), name="stream-refresh")
        try:
            await self._shutdown.wait()
        finally:
            await _drain(refresh_task)
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
        rows = await asyncio.to_thread(self.db.list_inboxes)
        desired: Dict[str, Dict[str, Any]] = {r["name"]: r for r in rows}

        # Cancel tasks for inboxes that no longer exist.
        removed = [n for n in self._stream_tasks if n not in desired]
        for name in removed:
            await self._stop_stream(name, reason="removed from DB")

        added = 0
        updated = 0
        for name, row in desired.items():
            # user_id is part of the signature so reassigning ownership (e.g. an
            # inbox that gains an owner) restarts the task and rebuilds the
            # pipeline — otherwise it keeps the stale owner and never notifies.
            sig = (row["config_json"], row.get("user_id"))
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
            logger.error("Failed to build stream %r: %s", name, exc)
            return
        task = asyncio.create_task(
            self._run_stream(stream, row.get("user_id")),
            name=f"stream:{name}",
        )
        self._stream_tasks[name] = task
        self._stream_config_sig[name] = (row["config_json"], row.get("user_id"))

    async def _stop_stream(self, name: str, *, reason: str) -> None:
        task = self._stream_tasks.pop(name, None)
        self._stream_config_sig.pop(name, None)
        if task is None or task.done():
            return
        logger.info("Stopping stream %r (%s)", name, reason)
        await _drain(task)

    def _build_stream(self, row: Dict[str, Any]) -> EmailStream:
        config = MailAccountConfig.model_validate_json(row["config_json"])
        return EmailStream(
            name=row["name"],
            config=config,
            on_token_refreshed=lambda token_json, name=row["name"]: self._persist_email_token(name, token_json),
        )

    def _persist_email_token(self, name: str, token_json: str) -> None:
        """Write a refreshed OAuth token back into the inbox's stored config."""
        row = self.db.get_inbox(name)
        if not row:
            return
        config = MailAccountConfig.model_validate_json(row["config_json"])
        config.auth.token_json = token_json
        self.db.upsert_inbox(
            name, config.model_dump_json(), user_id=row.get("user_id")
        )

    async def _run_stream(self, stream: EmailStream, user_id: Optional[int]) -> None:
        while not self._shutdown.is_set():
            try:
                # Each inbox is processed with its owner's criteria + push
                # subscriptions, both read live from the DB at point of use.
                pipeline = MessagePipeline(
                    db=self.db,
                    classifier=self.classifier,
                    user_id=user_id,
                )
                sem = asyncio.Semaphore(_PER_STREAM_CONCURRENCY)
                in_flight: set[asyncio.Task] = set()

                async def _handle(message: Message) -> None:
                    async with sem:
                        await pipeline.process(message)

                try:
                    async for message in stream.messages():
                        if self._shutdown.is_set():
                            break
                        t = asyncio.create_task(_handle(message))
                        in_flight.add(t)
                        t.add_done_callback(in_flight.discard)

                    if in_flight:
                        await asyncio.gather(*in_flight, return_exceptions=True)
                finally:
                    # On cancellation (stream stopped/reconfigured) don't leave
                    # message tasks running detached — cancel whatever's left.
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
        # Cancel everything first so the tasks tear down concurrently, then
        # drain each in turn.
        tasks = list(self._stream_tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            await _drain(task)
        self._stream_tasks.clear()
        self._stream_config_sig.clear()


class MessagePipeline:
    """Per-user processing for one message: dedup → classify → record → notify.

    The dedup ledger is the `message` table, and a row is written only once the
    message reaches a terminal outcome (classified, or permanently failed). A
    transient classifier error therefore leaves no row, so the message is retried
    on the next poll instead of being silently swallowed.

    User state — classification criteria and push subscriptions — is read live
    from the DB at point of use, so enabling notifications or editing criteria
    takes effect on the owner's next message without restarting the worker.
    """

    def __init__(
        self,
        *,
        db: Database,
        classifier: OpenAIMessageClassifier,
        user_id: Optional[int] = None,
    ):
        self.db = db
        self.user_id = user_id
        self.classifier = classifier
        # Per-user delivery: Web Push to every device the user registered, the
        # subscription list resolved at send time (see _current_subscriptions).
        self.notifier: Optional[WebPushNotifier] = None
        if settings.vapid_configured() and user_id is not None:
            assert settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY
            self.notifier = WebPushNotifier(
                public_key_b64=settings.VAPID_PUBLIC_KEY,
                private_key_b64_pem=settings.VAPID_PRIVATE_KEY,
                subject=settings.VAPID_SUBJECT,
                subscriptions_provider=self._current_subscriptions,
                on_dead=self.db.delete_push_subscription,
            )

    def _current_subscriptions(self) -> list[dict]:
        """Resolve the owner's push subscriptions now. Called at send time from a
        worker thread (sync DB read is fine there). Empty ⇒ no devices ⇒ skip."""
        if self.user_id is None:
            return []
        return self.db.get_push_subscriptions(self.user_id)

    async def _notify_with_retry(
        self, message: Message, classification: ClassificationResult
    ) -> "NotifyResult":
        """Send the alert, retrying a few times on transient (retryable)
        failures with exponential backoff. Only called when notifier is set."""
        assert self.notifier is not None
        delay = _NOTIFY_RETRY_BASE_DELAY
        result = await asyncio.to_thread(self.notifier.notify, message, classification)
        for _ in range(_NOTIFY_RETRY_ATTEMPTS - 1):
            if result.status != NotifyStatus.FAILED or not result.retryable:
                return result
            await asyncio.sleep(delay)
            delay *= 2
            result = await asyncio.to_thread(self.notifier.notify, message, classification)
        return result

    def _log_ctx(self, message: Message) -> str:
        """Stable key=value prefix so one message's journey is greppable across
        the pipeline's log lines."""
        inbox = message.inbox_name or "-"
        user = self.user_id if self.user_id is not None else "-"
        return f"msg={message.id} inbox={inbox} user={user}"

    async def process(self, message: Message) -> bool:
        ctx = self._log_ctx(message)
        if await asyncio.to_thread(self.db.is_message_recorded, message.id):
            logger.debug("%s outcome=dedup_skip", ctx)
            return False

        notes = ""
        if self.user_id is not None:
            user = await asyncio.to_thread(self.db.get_user, self.user_id)
            notes = (user or {}).get("criteria") or ""

        try:
            classification = await self.classifier.classify(message, notes=notes)
        except Exception as exc:
            if _is_transient_classification_error(exc):
                # Leave no row — the message is retried on the next poll.
                logger.warning("%s outcome=classify_retry error=%s", ctx, exc)
                return False
            # Permanent failure: record message + failure atomically so we stop retrying.
            await asyncio.to_thread(self._record_failure, message, str(exc))
            logger.error("%s outcome=classify_failed error=%s", ctx, exc)
            return False

        recorded = await asyncio.to_thread(self._record_classification, message, classification)
        if not recorded:
            # Another worker recorded this message between the dedup check and the
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
            reason = "webpush_not_configured" if not settings.vapid_configured() else "stream_has_no_owner"
            logger.warning(
                "%s outcome=classified priority=important notify=skipped reason=%s", ctx, reason
            )
            return True

        result = await self._notify_with_retry(message, classification)
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

    def _message_fields(self, message: Message) -> Dict[str, Any]:
        """The message-table columns, shared by every write."""
        return dict(
            source_id=message.id,
            inbox_name=message.inbox_name,
            title=message.title or "(no title)",
            body=message.body or None,
            url=message.url,
            author=message.author or None,
            received_at=message.received_at,
        )

    def _record_classification(
        self, message: Message, classification: ClassificationResult
    ) -> bool:
        """Atomically record the message + its classification. False ⇒ dedup race."""
        return self.db.record_classified_message(
            **self._message_fields(message),
            priority=classification.priority.value,
            summary=classification.summary,
            reasoning=classification.reasoning,
            model=settings.LLM_MODEL or "unknown",
        )

    def _record_failure(self, message: Message, error: str) -> bool:
        """Atomically record the message + a permanent-failure marker."""
        return self.db.record_failed_message(**self._message_fields(message), error=error)


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
