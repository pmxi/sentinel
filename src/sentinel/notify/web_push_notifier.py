"""Web Push notifier for Messages.

Sends an important-message alert to every browser/device a user has registered
(via the PWA "Enable notifications" button). The payload is a small JSON object
the service worker renders into a notification:

    {"title": "<sender address>", "body": "<summary>", "url": "<deep link>"}

A user can have several subscriptions (phone, laptop, ...), so notify() fans out
to all of them. Endpoints reported gone by the push service (404/410) are pruned
via the on_dead callback so dead devices don't accumulate.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from email.utils import parseaddr
from enum import Enum
from typing import Any, Callable, Dict, List

from py_vapid import Vapid02
from pywebpush import WebPushException, webpush

from sentinel.logging_config import get_logger
from sentinel.classifier import ClassificationResult
from sentinel.message import Message

logger = get_logger(__name__)


class NotifyStatus(str, Enum):
    SENT = "sent"
    SKIPPED = "skipped"
    FAILED = "failed"


@dataclass(frozen=True)
class NotifyResult:
    """Why a notify attempt did (or didn't) deliver.

    detail carries a short outcome summary (e.g. "2/3 sent") on success,
    otherwise the reason — so the caller can log a cause instead of silently
    dropping a None.

    retryable marks a FAILED result the caller may sensibly re-attempt (a
    network blip or a push-service 5xx), as opposed to a permanent rejection.
    """

    status: NotifyStatus
    detail: str = ""
    retryable: bool = False


class WebPushNotifier:
    """Formats a Message and pushes it to all of a user's registered devices.

    The destination subscriptions are resolved lazily via `subscriptions_provider`
    at send time, not captured up front — so a user who enables notifications
    after the worker is already polling still gets their next important message.
    Returns a NotifyResult describing the aggregate outcome.
    """

    def __init__(
        self,
        *,
        public_key_b64: str,
        private_key_b64_pem: str,
        subject: str,
        subscriptions_provider: Callable[[], List[Dict[str, str]]],
        on_dead: Callable[[str], None],
    ):
        # Decode the base64(PEM) private key once into a reusable Vapid signer.
        self._vapid = Vapid02.from_pem(base64.b64decode(private_key_b64_pem))
        self._public_key = public_key_b64
        self._claims = {"sub": subject}
        self._subscriptions_provider = subscriptions_provider
        self._on_dead = on_dead

    def notify(self, message: Message, classification: ClassificationResult) -> NotifyResult:
        subscriptions = self._subscriptions_provider()
        if not subscriptions:
            return NotifyResult(NotifyStatus.SKIPPED, "no_subscriptions")

        payload = self._payload(message, classification)

        sent = 0
        retryable = False
        last_error = ""
        for sub in subscriptions:
            status, detail = self._send_one(sub, payload)
            if status == NotifyStatus.SENT:
                sent += 1
            else:
                last_error = detail
                retryable = retryable or (status == NotifyStatus.FAILED and detail == "transient")

        total = len(subscriptions)
        if sent:
            return NotifyResult(NotifyStatus.SENT, f"{sent}/{total} sent")
        # Nothing delivered. If every failure was a dead endpoint we pruned,
        # there is no live device left — surface that distinctly from a
        # transient outage worth retrying.
        if retryable:
            return NotifyResult(NotifyStatus.FAILED, last_error or "transient", retryable=True)
        return NotifyResult(NotifyStatus.SKIPPED, "all_subscriptions_dead")

    def _send_one(self, sub: Dict[str, str], payload: str) -> tuple[NotifyStatus, str]:
        """Push to a single subscription. Returns (status, detail). Prunes the
        endpoint on a permanent 404/410."""
        endpoint = sub["endpoint"]
        subscription_info: Dict[str, Any] = {
            "endpoint": endpoint,
            "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=self._vapid,
                vapid_claims=dict(self._claims),
                timeout=10,
            )
            return (NotifyStatus.SENT, "ok")
        except WebPushException as e:
            status_code = getattr(e.response, "status_code", None)
            if status_code in (404, 410):
                logger.info("pruning dead push endpoint (%s)", status_code)
                self._on_dead(endpoint)
                return (NotifyStatus.SKIPPED, "endpoint_gone")
            if status_code is not None and status_code >= 500:
                logger.warning("transient web push error: %s", e)
                return (NotifyStatus.FAILED, "transient")
            logger.error("web push rejected: %s", e)
            return (NotifyStatus.FAILED, f"http_{status_code}")
        except Exception as e:  # network blip, timeout, etc.
            logger.warning("web push send error: %s", e)
            return (NotifyStatus.FAILED, "transient")

    def _payload(self, message: Message, classification: ClassificationResult) -> str:
        summary = classification.summary or ""
        if len(summary) > 500:
            summary = summary[:497] + "..."
        return json.dumps(
            {
                "title": _attribution(message),
                "body": summary,
                "url": message.url or "",
            }
        )


def _attribution(message: Message) -> str:
    """The text that goes on the notification's first line: the sender's bare
    email address (display name stripped)."""
    _, addr = parseaddr(message.author or "")
    return addr or message.author or "email"
