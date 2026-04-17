"""Importance classifier for Items from any Stream.

Uses OpenAI's Responses API with a Pydantic-parsed structured output.
The prompt adapts by item.source_type so the model gets source-specific
"what counts as important" guidance without a separate classifier per type.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from openai import OpenAI
from pydantic import BaseModel

from sentinel_core.config import settings
from sentinel_core.logging_config import get_logger
from sentinel_core.streams.base import Item

logger = get_logger(__name__)

# Hard cap on how much body we hand to the LLM. Sized generously so
# legitimate long content goes through; bigger than this is essentially
# always bloated HTML or inline attachments. Truncation is logged.
_MAX_BODY_CHARS = 50_000


class Priority(str, Enum):
    IMPORTANT = "important"
    NORMAL = "normal"


@dataclass(frozen=True)
class ClassificationResult:
    priority: Priority
    reasoning: str
    summary: Optional[str] = None

    def is_important(self) -> bool:
        return self.priority == Priority.IMPORTANT

    def __str__(self) -> str:
        return (
            f"Priority: {self.priority.value.capitalize()}\n"
            f"Reasoning: {self.reasoning}\n"
            f"Summary: {self.summary or 'N/A'}"
        )


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


class ItemClassifier:
    """Classifies any Item via the OpenAI Responses API."""

    def __init__(self):
        if not settings.LLM_API_KEY:
            raise ValueError("LLM_API_KEY not found.")
        self.client = OpenAI(api_key=settings.LLM_API_KEY)

    async def classify(self, item: Item, notes: str = "") -> ClassificationResult:
        """Async entry — wraps the blocking OpenAI call in a thread."""
        return await asyncio.to_thread(self._classify_sync, item, notes)

    def _classify_sync(self, item: Item, notes: str) -> ClassificationResult:
        response = self.client.responses.parse(
            model=settings.LLM_MODEL,
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
        criteria = _criteria_for(item.source_type)
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
                "Item body truncated for LLM: source=%s id=%s title=%r "
                "original=%d chars limit=%d chars",
                item.source_type,
                item.id,
                item.title[:80],
                original_size,
                _MAX_BODY_CHARS,
            )
        return body


def _criteria_for(source_type: str) -> str:
    """Source-specific 'what's important' guidance appended to the base prompt."""
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
    # Default: let the notes + general sense of 'important' decide.
    return (
        "IMPORTANT items are those the user would genuinely want to be "
        "alerted about right now. NORMAL items are everything else."
    )
