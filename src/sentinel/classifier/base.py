"""Pure classification interfaces."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Priority(str, Enum):
    IMPORTANT = "important"
    NORMAL = "normal"


@dataclass(frozen=True)
class ClassificationResult:
    priority: Priority
    reasoning: str
    summary: str

    def is_important(self) -> bool:
        return self.priority == Priority.IMPORTANT
