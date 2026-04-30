"""Local text classifier — runs the trained could-be-news head on every item.

Wraps the sklearn Pipeline produced by tools/train_classifier.py. Loaded
once at supervisor startup so the encoder weights live in memory; subsequent
.score() calls are a single forward pass plus a sparse dot product.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import List, Optional, Tuple

import joblib

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item

logger = get_logger(__name__)

# joblib needs `embedder.SentenceEmbedder` importable to unpickle. The class
# lives in the standalone tools/ folder; add it to sys.path so the runtime
# can deserialize models trained there without copying the file around.
_TOOLS = Path(__file__).resolve().parents[2] / "tools"
if _TOOLS.is_dir() and str(_TOOLS) not in sys.path:
    sys.path.insert(0, str(_TOOLS))


class LocalTextScorer:
    """Loads a trained Pipeline and returns P(news) per Item."""

    def __init__(self, model_path: Path):
        self.model_path = model_path
        self.pipe = joblib.load(str(model_path))
        # Force-warm the encoder so the first real item doesn't pay the
        # ~60s cold-start cost mid-firehose.
        embed = self.pipe.named_steps.get("embed")
        if embed is not None:
            embed.transform(["warmup"])
        logger.info("loaded local scorer: %s", model_path)

    _MAX_CHARS = 512

    @classmethod
    def _text_for(cls, item: Item) -> str:
        # For Bluesky, title and body are the same string; dedupe to avoid
        # encoding it twice. For everything else, concatenate. Cap total at
        # 512 chars — beyond that the encoder cost balloons and the marginal
        # signal for "is this news" is zero.
        title = item.title or ""
        body = item.body or ""
        if body and body != title:
            text = f"{title}\n{body}"
        else:
            text = title
        return text[: cls._MAX_CHARS]

    def score(self, item: Item) -> float:
        return float(self.pipe.predict_proba([self._text_for(item)])[0, 1])

    def batch_score(self, items: List[Item]) -> List[float]:
        """Score a batch of items in a single Pipeline call.

        The encoder's internal batch_size still caps how many texts go into
        one forward pass, but a single sklearn predict_proba avoids per-call
        overhead and lets the encoder do its own batching efficiently.
        """
        if not items:
            return []
        texts = [self._text_for(i) for i in items]
        probs = self.pipe.predict_proba(texts)[:, 1]
        return [float(p) for p in probs]

    @classmethod
    def maybe_load(cls, model_path: Path) -> Optional["LocalTextScorer"]:
        if not model_path.exists():
            logger.info("no scorer model at %s; per-item scoring disabled", model_path)
            return None
        try:
            return cls(model_path)
        except Exception as exc:
            logger.warning("failed to load scorer at %s: %s", model_path, exc)
            return None


class BatchScorer:
    """Async batching wrapper around LocalTextScorer.

    Stream tasks call .score(item) and await; this scorer collects pending
    items, encodes them in batches (single Qwen forward pass per batch via
    predict_proba over a list), and resolves each item's future.

    Tradeoff: each item pays at most `max_wait_ms` of latency before its
    batch flushes. Set low enough that the dashboard still feels live;
    high enough that batches actually fill.
    """

    def __init__(
        self,
        scorer: LocalTextScorer,
        max_batch: int = 32,
        max_wait_ms: int = 50,
    ):
        self.scorer = scorer
        self.max_batch = max_batch
        self.max_wait_ms = max_wait_ms
        self._queue: "asyncio.Queue[Tuple[Item, asyncio.Future]]" = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="batch-scorer")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def score(self, item: Item) -> float:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        await self._queue.put((item, fut))
        return await fut

    async def _run(self) -> None:
        wait_seconds = self.max_wait_ms / 1000
        n_batches = 0
        n_items = 0
        last_log = time.monotonic()
        while True:
            first = await self._queue.get()
            batch: List[Tuple[Item, asyncio.Future]] = [first]
            deadline = time.monotonic() + wait_seconds
            while len(batch) < self.max_batch:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    nxt = await asyncio.wait_for(self._queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                batch.append(nxt)

            items = [it for it, _ in batch]
            t0 = time.monotonic()
            try:
                scores = await asyncio.to_thread(self.scorer.batch_score, items)
                for (_, fut), s in zip(batch, scores):
                    if not fut.done():
                        fut.set_result(s)
            except Exception as exc:
                logger.exception("batch scoring failed (size=%d): %s", len(batch), exc)
                for _, fut in batch:
                    if not fut.done():
                        fut.set_exception(exc)
            elapsed_ms = (time.monotonic() - t0) * 1000
            n_batches += 1
            n_items += len(batch)
            if time.monotonic() - last_log > 10:
                logger.info(
                    "scorer: %d batches, %d items in last %.1fs (avg batch=%.1f, last batch=%d in %.0fms, qsize=%d)",
                    n_batches, n_items, time.monotonic() - last_log,
                    n_items / max(n_batches, 1), len(batch), elapsed_ms, self._queue.qsize(),
                )
                n_batches = 0
                n_items = 0
                last_log = time.monotonic()
