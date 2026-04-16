"""Email classification using OpenAI's Responses API."""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from openai import OpenAI
from pydantic import BaseModel

from sentinel.config import settings
from sentinel.email.models import EmailData
from sentinel.logging_config import get_logger

logger = get_logger(__name__)

# Hard cap on how much of an email body we hand to the LLM. Sized generously
# so legitimate long threads (~30KB) go through untouched; bigger than this is
# essentially always inline-base64 attachments, bloated HTML newsletters, or
# malformed MIME. Truncation is logged at WARNING so it's observable.
_MAX_EMAIL_BODY_CHARS = 50_000


class EmailPriority(str, Enum):
    """Email classification categories"""

    IMPORTANT = "important"
    NORMAL = "normal"


@dataclass(frozen=True)
class ClassificationResult:
    """Result of email classification — clean interface for consumers."""

    priority: EmailPriority
    reasoning: str
    summary: Optional[str] = None

    def is_important(self) -> bool:
        return self.priority == EmailPriority.IMPORTANT

    def __str__(self) -> str:
        return (
            f"Priority: {self.priority.value.capitalize()}\n"
            f"Reasoning: {self.reasoning}\n"
            f"Summary: {self.summary or 'N/A'}"
        )


class _ClassificationResponse(BaseModel):
    """Pydantic schema handed to OpenAI's structured-output parser."""

    priority: EmailPriority
    reasoning: str
    summary: str

    def to_result(self) -> ClassificationResult:
        return ClassificationResult(
            priority=self.priority,
            reasoning=self.reasoning,
            summary=self.summary,
        )


class EmailClassifier:
    """Classifies emails via the OpenAI Responses API with Pydantic-parsed output."""

    def __init__(self):
        if not settings.LLM_API_KEY:
            raise ValueError("LLM_API_KEY not found.")
        self.client = OpenAI(api_key=settings.LLM_API_KEY)

    def classify_email(self, email: EmailData) -> ClassificationResult:
        response = self.client.responses.parse(
            model=settings.LLM_MODEL,
            input=self._create_classification_prompt(email),
            text_format=_ClassificationResponse,
        )

        parsed = response.output_parsed
        if parsed is None:
            raise ValueError("OpenAI Responses API returned no parsed output")
        return parsed.to_result()

    def _create_classification_prompt(self, email: EmailData) -> str:
        extra = settings.CLASSIFICATION_NOTES.strip()
        extra_block = f"\nADDITIONAL NOTES FROM THE USER (take these seriously):\n{extra}\n" if extra else ""
        email_text = self._render_email_for_llm(email)
        return f"""
You are an email classification assistant. Analyze the following email and classify it as IMPORTANT or NORMAL.

IMPORTANT:
- Addressed to me personally
- Job interview offer
- Legal matter
- Urgent

NORMAL:
- Everything else, including newsletters, mass mailings, and apparent scams
{extra_block}
EMAIL TO CLASSIFY:
{email_text}

Return:
- priority: "important" or "normal"
- reasoning: brief explanation
- summary: concise 140-character summary
"""

    def _render_email_for_llm(self, email: EmailData) -> str:
        """Render the email as plaintext for the prompt, truncating the body
        if it's pathologically long. Headers always go through in full."""
        body = email.body
        original_size = len(body)
        if original_size > _MAX_EMAIL_BODY_CHARS:
            body = (
                body[:_MAX_EMAIL_BODY_CHARS]
                + f"\n\n[... truncated from {original_size:,} chars ...]"
            )
            logger.warning(
                "Email body truncated for LLM: id=%s from=%s subject=%r original=%d chars limit=%d chars",
                email.id,
                email.sender[:80],
                email.subject[:80],
                original_size,
                _MAX_EMAIL_BODY_CHARS,
            )

        return (
            f"From: {email.sender}\n"
            f"To: {email.recipient}\n"
            f"Subject: {email.subject}\n"
            f"Date: {email.received_date}\n\n"
            f"{body}"
        )
