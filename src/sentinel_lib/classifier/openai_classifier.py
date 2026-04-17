"""OpenAI-backed classifier adapter."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from openai import OpenAI
from pydantic import BaseModel

from sentinel_lib.logging_config import get_logger
from sentinel_lib.classifier.base import ClassificationResult, Priority
from sentinel_lib.streams.base import Item

logger = get_logger(__name__)

_MAX_BODY_CHARS = 50_000


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
    """Concrete classifier that delegates to the OpenAI Responses API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "gpt-5.4",
        criteria_provider: Callable[[str], str] | None = None,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        self.client = OpenAI(api_key=api_key)
        self.model = model
        self._criteria_provider = criteria_provider or _default_criteria_for

    async def classify(self, item: Item, notes: str = "") -> ClassificationResult:
        return await asyncio.to_thread(self._classify_sync, item, notes)

    def _classify_sync(self, item: Item, notes: str) -> ClassificationResult:
        response = self.client.responses.parse(
            model=self.model,
            input=self._build_prompt(item, notes),
            text_format=_ClassificationResponse,
        )
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
    return (
        "IMPORTANT items are those the user would genuinely want to be alerted about right now. "
        "NORMAL items are everything else."
    )
