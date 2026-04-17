"""Base class for item-level notifications.

An ItemNotifier turns an (Item, ClassificationResult) pair into a user-visible
notification over some channel (Telegram, email, SMS, etc.). Subclasses only
decide the formatting + transport.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from sentinel_lib.classifier import ClassificationResult
from sentinel_lib.streams.base import Item


class ItemNotifier(ABC):
    @abstractmethod
    def notify(self, item: Item, classification: ClassificationResult) -> Optional[str]:
        """Send a notification. Returns a provider message id on success,
        or None on failure."""
        raise NotImplementedError
