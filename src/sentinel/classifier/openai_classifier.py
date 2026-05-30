"""OpenAI-backed classifier adapter."""

from __future__ import annotations

import asyncio
import time

import httpx
from openai import APIError, APIStatusError, AsyncOpenAI, RateLimitError
from pydantic import BaseModel

from sentinel.logging_config import get_logger
from sentinel.classifier.base import ClassificationResult, Priority
from sentinel.item import Item

logger = get_logger(__name__)

_MAX_BODY_CHARS = 50_000

# httpx connection-pool ceilings, kept comfortably above _MAX_INFLIGHT so a
# burst doesn't block on connection acquisition.
_HTTPX_MAX_CONNECTIONS = 128
_HTTPX_MAX_KEEPALIVE = 32

# Hard cap on concurrent OpenAI requests, bounding our load on the org's
# RPM/TPM limits regardless of how many inboxes are being polled at once.
_MAX_INFLIGHT = 48


class _ClassificationResponse(BaseModel):
    priority: Priority
    reasoning: str
    summary: str

    def to_result(self) -> ClassificationResult:
        return ClassificationResult(
            priority=self.priority,
            reasoning=self.reasoning,
            summary=self.summary,
        )


class OpenAIItemClassifier:
    """Concrete classifier that delegates to the OpenAI Responses API.

    Uses the async client so each classify call yields the event loop instead
    of holding a thread for the whole OpenAI round-trip."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-5.4-mini",
        reasoning_effort: str | None = None,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        # Override the SDK's default httpx client to raise the connection-pool
        # ceiling above our concurrency cap.
        http_client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=_HTTPX_MAX_CONNECTIONS,
                max_keepalive_connections=_HTTPX_MAX_KEEPALIVE,
            ),
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        self.client = AsyncOpenAI(api_key=api_key, http_client=http_client)
        self.model = model
        # Reasoning models (gpt-5.x) accept a reasoning.effort; only send it when
        # configured so non-reasoning models don't receive an unknown parameter.
        self._extra_params: dict = (
            {"reasoning": {"effort": reasoning_effort}} if reasoning_effort else {}
        )
        self._inflight = asyncio.Semaphore(_MAX_INFLIGHT)

    async def classify(self, item: Item, notes: str = "") -> ClassificationResult:
        async with self._inflight:
            t0 = time.monotonic()
            try:
                response = await self.client.responses.parse(
                    model=self.model,
                    input=self._build_prompt(item, notes),
                    text_format=_ClassificationResponse,
                    **self._extra_params,
                )
            except RateLimitError as exc:
                logger.warning("OpenAI rate-limited after %.1fs: %s", time.monotonic() - t0, exc)
                raise
            except (APIError, APIStatusError) as exc:
                logger.warning("OpenAI API error after %.1fs: %s", time.monotonic() - t0, exc)
                raise
            parsed = response.output_parsed
            if parsed is None:
                raise ValueError("OpenAI Responses API returned no parsed output")
            return parsed.to_result()

    def _build_prompt(self, item: Item, notes: str) -> str:
        # The user's saved criteria, edited directly in the console, IS the
        # criteria. Fall back to the built-in default only when it's empty.
        criteria = (notes or "").strip() or _default_criteria()
        body = item.body
        if len(body) > _MAX_BODY_CHARS:
            logger.warning(
                "Item body truncated for LLM: id=%s title=%r original=%d chars limit=%d chars",
                item.id, item.title[:80], len(body), _MAX_BODY_CHARS,
            )
            body = body[:_MAX_BODY_CHARS] + f"\n\n[... truncated to {_MAX_BODY_CHARS:,} chars ...]"
        return f"""
You are a classification assistant. The user wants to be alerted only to the
emails that genuinely matter to them. Classify the following item as IMPORTANT or NORMAL.

{criteria}

ITEM TO CLASSIFY:
{body}

Return:
- priority: "important" or "normal"
- reasoning: brief explanation
- summary: concise 140-character summary
"""


def _default_criteria() -> str:
    return (
        "IMPORTANT emails:\n"
        "- Addressed to me personally\n"
        "- Job interview offer\n"
        "- Legal matter\n"
        "- Urgent\n\n"
        "NORMAL emails:\n"
        "- Everything else, including newsletters, mass mailings, and apparent scams"
    )
