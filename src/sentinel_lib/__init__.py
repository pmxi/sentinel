"""Pure Sentinel library abstractions."""

from sentinel_lib.classifier import ClassificationResult, Classifier, OpenAIItemClassifier, Priority
from sentinel_lib.notify import ItemNotifier, Notifier, TelegramItemNotifier, TelegramNotifier
from sentinel_lib.processing import ItemProcessor, ProcessingEvent, ProcessingObserver, ProcessedItemStore
from sentinel_lib.streams.base import Item, Stream

__all__ = [
    "ClassificationResult",
    "Classifier",
    "Item",
    "ItemNotifier",
    "ItemProcessor",
    "Notifier",
    "OpenAIItemClassifier",
    "Priority",
    "ProcessedItemStore",
    "ProcessingEvent",
    "ProcessingObserver",
    "Stream",
    "TelegramItemNotifier",
    "TelegramNotifier",
]
