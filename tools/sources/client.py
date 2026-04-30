"""Thin retry/pagination wrapper around mediacloud.api.DirectoryApi."""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Iterator

import mediacloud.api as mca
import requests

logger = logging.getLogger(__name__)

API_KEY_ENV = "MEDIACLOUD_API_KEY"
PAGE_SIZE = 5000
MAX_RETRIES = 5
BACKOFF_BASE_SECONDS = 2.0


class MediacloudClient:
    def __init__(self, api_key: str | None = None, page_size: int = PAGE_SIZE):
        key = api_key or os.environ.get(API_KEY_ENV)
        if not key:
            raise RuntimeError(
                f"set {API_KEY_ENV} (get a key from https://search.mediacloud.org)"
            )
        self.api = mca.DirectoryApi(key)
        self.page_size = page_size

    def quota(self) -> dict[str, Any]:
        return self.api.user_profile().get("quota", {})

    def iter_collections(self) -> Iterator[dict[str, Any]]:
        yield from self._paginate(self.api.collection_list)

    def iter_sources(self) -> Iterator[dict[str, Any]]:
        yield from self._paginate(self.api.source_list)

    def _paginate(self, fn) -> Iterator[dict[str, Any]]:
        offset = 0
        while True:
            page = self._call(fn, limit=self.page_size, offset=offset)
            results = page.get("results", [])
            if not results:
                return
            for item in results:
                yield item
            if not page.get("next"):
                return
            offset += len(results)

    def _call(self, fn, **kwargs) -> dict[str, Any]:
        last_exc: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                return fn(**kwargs)
            except requests.HTTPError as exc:
                status = exc.response.status_code if exc.response is not None else None
                # Retry transient server errors and rate limits.
                if status in (429, 500, 502, 503, 504):
                    last_exc = exc
                    sleep = BACKOFF_BASE_SECONDS * (2**attempt)
                    logger.warning(
                        "mediacloud %s -> HTTP %s (attempt %d/%d); sleeping %.1fs",
                        getattr(fn, "__name__", "?"),
                        status,
                        attempt + 1,
                        MAX_RETRIES,
                        sleep,
                    )
                    time.sleep(sleep)
                    continue
                raise
            except requests.RequestException as exc:
                last_exc = exc
                sleep = BACKOFF_BASE_SECONDS * (2**attempt)
                logger.warning(
                    "mediacloud %s -> %s (attempt %d/%d); sleeping %.1fs",
                    getattr(fn, "__name__", "?"),
                    exc,
                    attempt + 1,
                    MAX_RETRIES,
                    sleep,
                )
                time.sleep(sleep)
        assert last_exc is not None
        raise last_exc
