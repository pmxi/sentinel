"""OpenAI-backed classifier adapter."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

import httpx
from openai import APIError, APIStatusError, AsyncOpenAI, RateLimitError
from pydantic import BaseModel

from sentinel.core.logging_config import get_logger
from sentinel.core.classifier.base import ClassificationResult, Priority
from sentinel.core.streams.base import Item

logger = get_logger(__name__)

_MAX_BODY_CHARS = 50_000

# Pool size on the underlying httpx client. Larger than _MAX_INFLIGHT below
# so brief bursts don't block on connection acquisition.
_HTTPX_MAX_CONNECTIONS = 128
_HTTPX_MAX_KEEPALIVE = 32

# Hard cap on concurrent OpenAI requests. The right value depends on the
# OpenAI org's RPM/TPM limits — gpt-4o-mini Tier 1 is ~500 RPM. With each
# request taking ~1-2s under normal conditions, 32 concurrent gives ~1k RPM.
# Higher = better steady-state throughput; too high = throttling that
# silently extends per-request latency to many seconds.
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

    Uses the async client so each classify call yields the event loop
    instead of consuming a thread for the entire OpenAI roundtrip. At
    scale (hundreds of in-flight classifications) the previous
    asyncio.to_thread approach saturated the default executor and
    capped throughput at ~1-3 classifications/sec."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-4o-mini",
        criteria_provider: Callable[[str], str] | None = None,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        # Override the SDK's default httpx client so we can raise the
        # connection pool ceiling (defaults are tiny relative to our scale).
        http_client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=_HTTPX_MAX_CONNECTIONS,
                max_keepalive_connections=_HTTPX_MAX_KEEPALIVE,
            ),
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
        self.client = AsyncOpenAI(api_key=api_key, http_client=http_client)
        self.model = model
        self._criteria_provider = criteria_provider or _default_criteria_for
        # Global concurrency cap. Without it the per-stream sem (64) lets
        # thousands of streams overrun OpenAI's effective RPM limit and
        # every call queues for many seconds.
        self._inflight = asyncio.Semaphore(_MAX_INFLIGHT)

    async def classify(self, item: Item, notes: str = "") -> ClassificationResult:
        async with self._inflight:
            t0 = time.monotonic()
            try:
                response = await self.client.responses.parse(
                    model=self.model,
                    input=self._build_prompt(item, notes),
                    text_format=_ClassificationResponse,
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
        extra = (notes or "").strip()
        extra_block = (
            f"\nADDITIONAL NOTES FROM THE USER (take these seriously):\n{extra}\n"
            if extra
            else ""
        )
        criteria = self._criteria_provider(item.source_type)
        rendered = self._render_item(item)
        return f"""
You are a classification assistant. The user subscribes to several information streams
(email, RSS news, GitHub notifications, etc.) and wants to be alerted only to the items
that genuinely matter to them. Classify the following item as IMPORTANT or NORMAL.

{criteria}
{extra_block}
ITEM TO CLASSIFY (source: {item.source_type}):
{rendered}

Return:
- priority: "important" or "normal"
- reasoning: brief explanation
- summary: concise 140-character summary
"""

    def _render_item(self, item: Item) -> str:
        body = item.body
        original_size = len(body)
        if original_size > _MAX_BODY_CHARS:
            body = (
                body[:_MAX_BODY_CHARS]
                + f"\n\n[... truncated from {original_size:,} chars ...]"
            )
            logger.warning(
                "Item body truncated for LLM: source=%s id=%s title=%r original=%d chars limit=%d chars",
                item.source_type,
                item.id,
                item.title[:80],
                original_size,
                _MAX_BODY_CHARS,
            )
        return body


def _default_criteria_for(source_type: str) -> str:
    if source_type == "email":
        return (
            "IMPORTANT emails:\n"
            "- Addressed to me personally\n"
            "- Job interview offer\n"
            "- Legal matter\n"
            "- Urgent\n\n"
            "NORMAL emails:\n"
            "- Everything else, including newsletters, mass mailings, and apparent scams"
        )
    if source_type == "rss":
        return (
            "IMPORTANT RSS items:\n"
            "- Major breaking news with real consequences\n"
            "- Security advisories, outages, or vulnerabilities affecting widely-used software\n"
            "- Releases or announcements the user clearly cares about (based on their notes)\n\n"
            "NORMAL RSS items:\n"
            "- Routine posts, opinion pieces, speculative coverage, marketing"
        )
    if source_type == "sitemap_news":
        return (
            "These are news headlines pulled from publisher sitemaps. Most are routine "
            "and should be NORMAL.\n\n"
            "IMPORTANT news items:\n"
            "- Major breaking news (international crises, large-scale disasters, top-tier political events)\n"
            "- Events with material economic or security consequences\n"
            "- Stories the user clearly cares about based on their notes\n\n"
            "NORMAL news items:\n"
            "- Routine local news, sports scores, celebrity gossip, lifestyle pieces\n"
            "- Opinion columns, listicles, and product reviews\n"
            "- Any story without time-critical impact on the user"
        )
    return (
        "IMPORTANT items are those the user would genuinely want to be alerted about right now. "
        "NORMAL items are everything else."
    )
