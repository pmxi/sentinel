"""Pure classification interfaces."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from sentinel_lib.streams.base import Item


class Priority(str, Enum):
    IMPORTANT = "important"
    NORMAL = "normal"


@dataclass(frozen=True)
class ClassificationResult:
    priority: Priority
    reasoning: str
    summary: str | None = None

    def is_important(self) -> bool:
        return self.priority == Priority.IMPORTANT

    def __str__(self) -> str:
        return (
            f"Priority: {self.priority.value.capitalize()}\n"
            f"Reasoning: {self.reasoning}\n"
            f"Summary: {self.summary or 'N/A'}"
        )


@runtime_checkable
class Classifier(Protocol):
    async def classify(self, item: Item, notes: str = "") -> ClassificationResult:
        """Classify an item with optional runtime-provided notes."""
