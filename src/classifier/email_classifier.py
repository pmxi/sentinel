"""Email classification using LLM"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional

from google import genai  # type: ignore
from pydantic import BaseModel, Field

from src.config import settings
from src.email.gmail.models import EmailData


class EmailPriority(str, Enum):
    """Email classification categories"""

    IMPORTANT = "important"
    NORMAL = "normal"
    JUNK = "junk"


@dataclass(frozen=True)
class ClassificationResult:
    """Result of email classification - clean interface for consumers"""

    priority: EmailPriority
    confidence: float
    reasoning: str
    summary: Optional[str] = None

    def is_important(self) -> bool:
        """Check if email is important"""
        return self.priority == EmailPriority.IMPORTANT

    def is_high_confidence(self) -> bool:
        """Check if classification confidence is high (>= 0.8)"""
        return self.confidence >= 0.8

    def __str__(self) -> str:
        """String representation of the classification result"""
        return (
            f"Priority: {self.priority.value.capitalize()}\n"
            f"Confidence: {self.confidence:.2f}\n"
            f"Reasoning: {self.reasoning}\n"
            f"Summary: {self.summary or 'N/A'}"
        )


class _ClassificationResponse(BaseModel):
    """Internal Pydantic model for LLM response parsing"""

    priority: EmailPriority
    confidence: float = Field(..., ge=0.0, le=1.0)
    reasoning: str
    summary: Optional[str] = None

    def to_result(self) -> ClassificationResult:
        """Convert to public dataclass"""
        return ClassificationResult(
            priority=self.priority,
            confidence=self.confidence,
            reasoning=self.reasoning,
            summary=self.summary,
        )


class EmailClassifier:
    """Classifies emails using Google Gemini AI"""

    def __init__(self):
        """Initialize the email classifier"""
        if not settings.LLM_API_KEY:
            raise ValueError("LLM_API_KEY not found.")
        self.client = genai.Client(api_key=settings.LLM_API_KEY)

    def classify_email(self, email: EmailData) -> ClassificationResult:
        """Classify an email into one of the predefined categories"""
        prompt = self._create_classification_prompt(email)

        response = self.client.models.generate_content(
            model="gemini-2.5-flash-preview-05-20",
            contents=prompt,
            config={
                "response_mime_type": "application/json",
                "response_schema": _ClassificationResponse,
            },
        )

        if not response or not response.text:
            raise ValueError("No response received from the Gemini API")

        response = _ClassificationResponse.model_validate_json(response.text)
        return response.to_result()

    def _create_classification_prompt(self, email: EmailData) -> str:
        """Create a structured prompt for email classification"""
        email_text = email.__str__()

        return f"""
You are an email classification assistant. Analyze the following email and classify it into one of three categories:

IMPORTANT:
- Addressed to me personally
- Job interview offer- Legal matter
- Urgent

JUNK:
- Newsletter/updates from an org I don't have a relationship with
- Apparent scam

NORMAL:
- Everything else

EMAIL TO CLASSIFY:
{email_text}

Respond with a JSON object containing:
- priority: "important", "normal", or "junk"
- confidence: 0.0-1.0
- reasoning: Brief explanation
- summary: Concise 140-character summary
"""
