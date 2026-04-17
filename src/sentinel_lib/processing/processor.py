"""Generic item-processing flow shared by every runtime."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from sentinel_lib.classifier.base import ClassificationResult, Classifier
from sentinel_lib.notify.item_notifier import ItemNotifier
from sentinel_lib.streams.base import Item


@runtime_checkable
class ProcessedItemStore(Protocol):
    async def is_processed(self, item: Item) -> bool:
        """Return True when the runtime has already processed this item."""

    async def mark_processed(self, item: Item) -> None:
        """Persist that the item has been processed."""


@dataclass(frozen=True)
class ProcessingEvent:
    event_type: str
    item: Item
    classification: ClassificationResult | None = None
    error: str | None = None


@runtime_checkable
class ProcessingObserver(Protocol):
    async def publish(self, event: ProcessingEvent) -> None:
        """Observe processing lifecycle events."""


class ItemProcessor:
    """Shared per-item processing flow.

    The runtime owns storage, notes, and event routing. The library owns the
    stable classify/notify/mark-processed flow.
    """

    def __init__(
        self,
        *,
        classifier: Classifier,
        store: ProcessedItemStore,
        notifier: ItemNotifier | None = None,
        observer: ProcessingObserver | None = None,
        is_retryable_classifier_error: Callable[[Exception], bool] | None = None,
    ):
        self.classifier = classifier
        self.store = store
        self.notifier = notifier
        self.observer = observer
        self.is_retryable_classifier_error = (
            is_retryable_classifier_error or _never_retry
        )

    async def process(self, item: Item, *, notes: str = "") -> bool:
        if await self.store.is_processed(item):
            return False

        await self._publish(ProcessingEvent(event_type="item_received", item=item))

        should_mark_processed = False
        try:
            classification = await self.classifier.classify(item, notes=notes)
            await self._publish(
                ProcessingEvent(
                    event_type="item_classified",
                    item=item,
                    classification=classification,
                )
            )
            if classification.is_important() and self.notifier is not None:
                await asyncio.to_thread(self.notifier.notify, item, classification)
            should_mark_processed = True
        except Exception as exc:
            should_mark_processed = not self.is_retryable_classifier_error(exc)
            await self._publish(
                ProcessingEvent(
                    event_type="item_failed",
                    item=item,
                    error=str(exc),
                )
            )
            if not should_mark_processed:
                return False

        if should_mark_processed:
            await self.store.mark_processed(item)
            return True
        return False

    async def _publish(self, event: ProcessingEvent) -> None:
        if self.observer is not None:
            await self.observer.publish(event)


def _never_retry(_exc: Exception) -> bool:
    return False
