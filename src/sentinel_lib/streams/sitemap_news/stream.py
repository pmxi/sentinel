"""Google News sitemap stream.

Polls a publisher's `<news:news>` sitemap and yields one Item per fresh
article URL. Belt-and-suspenders dedup: an in-memory `_seen` set for the
process lifetime plus the runtime's processed_items ledger across restarts.
First poll primes the seen set without emitting (otherwise every restart
would re-flood the dashboard with the last 48h backlog).

Supports gzipped sitemaps transparently (NYT, WaPo). Sitemap *index* files
(roots that list child sitemaps rather than article URLs) are detected and
logged with guidance — wire those by pointing at a leaf sitemap directly.
"""

from __future__ import annotations

import asyncio
import gzip
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import AsyncIterator
from xml.etree import ElementTree as ET

import aiohttp

from sentinel_lib.logging_config import get_logger
from sentinel_lib.streams.base import Item, Stream
from sentinel_lib.streams.sitemap_news.config import SitemapNewsStreamConfig
from sentinel_lib.time_utils import utc_now

logger = get_logger(__name__)

# The news namespace URI is canonical and consistent across publishers
# (we resolve by URI, not the `news:` / `n:` prefix the publisher uses).
# The urlset/sitemapindex namespace varies — `sitemaps.org/0.9` is most
# common but Asahi serves news under the older `google.com/.../0.84`
# namespace. We match those by local name + wildcard, not by URI.
_NEWS_NS = "http://www.google.com/schemas/sitemap-news/0.9"
_NS = {"news": _NEWS_NS}


@dataclass(frozen=True, slots=True)
class SitemapEntry:
    url: str
    title: str
    published: datetime | None
    keywords: list[str]
    # Per-item publication metadata. Populated when <news:publication>
    # carries them; None otherwise. Multilingual feeds (BBC) put a
    # different name/language on every <url>, so trusting the stream
    # config alone would mislabel ~95% of items.
    publication_name: str | None
    language: str | None


class SitemapNewsStream(Stream):
    source_type = "sitemap_news"

    def __init__(self, name: str, config: SitemapNewsStreamConfig):
        super().__init__(name=name)
        self.config = config
        self._seen: set[str] = set()
        self._first_poll = True

    async def items(self) -> AsyncIterator[Item]:
        if not self.config.enabled:
            logger.info(f"SitemapNewsStream {self.name!r} is disabled; not starting")
            return

        logger.info(
            f"[{self.name}] starting sitemap-news stream: {self.config.sitemap_url} "
            f"(poll every {self.config.poll_seconds}s)"
        )
        headers = {"User-Agent": self.config.user_agent}

        async with aiohttp.ClientSession(headers=headers) as session:
            while True:
                try:
                    entries = await self._fetch_entries(session)
                    for entry in entries[: self.config.max_entries_per_poll]:
                        if entry.url in self._seen:
                            continue
                        self._seen.add(entry.url)
                        if self._first_poll:
                            continue
                        yield self._to_item(entry)
                    self._first_poll = False
                except Exception as exc:
                    logger.warning(f"[{self.name}] sitemap poll failed: {exc}")
                await asyncio.sleep(self.config.poll_seconds)

    async def _fetch_entries(
        self, session: aiohttp.ClientSession
    ) -> list[SitemapEntry]:
        async with session.get(self.config.sitemap_url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            resp.raise_for_status()
            raw = await resp.read()
        return parse_sitemap_bytes(raw)


def parse_sitemap_bytes(raw: bytes) -> list[SitemapEntry]:
    """Parse a Google News sitemap body into entries.

    Pure / synchronous so it's testable without a network. Handles:
      - gzipped bodies (NYT serves news.xml.gz)
      - the older google.com/.../sitemap/0.84 root namespace (Asahi)
      - the canonical sitemaps.org/0.9 root namespace
      - per-item <news:publication><news:name>/<news:language>
    Raises RuntimeError if the document is a sitemap index, not a leaf.
    """
    # aiohttp auto-decompresses gzipped HTTP responses, so don't trust
    # the URL suffix — only decompress when the bytes still carry the
    # gzip magic header.
    if _looks_gzipped(raw):
        raw = gzip.decompress(raw)

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise RuntimeError(f"invalid XML: {exc}") from exc

    tag = _local_name(root.tag)
    if tag == "sitemapindex":
        child = next(iter(root.findall("{*}sitemap/{*}loc")), None)
        child_url = child.text.strip() if child is not None and child.text else "(none)"
        raise RuntimeError(
            f"sitemap is an index, not a leaf — point at a child URL "
            f"(e.g. {child_url})"
        )
    if tag != "urlset":
        raise RuntimeError(f"unexpected root element: {tag!r}")

    out: list[SitemapEntry] = []
    for url_el in root.findall("{*}url"):
        loc_el = url_el.find("{*}loc")
        if loc_el is None or not loc_el.text:
            continue
        url = loc_el.text.strip()

        news_el = url_el.find("news:news", _NS)
        title = ""
        published: datetime | None = None
        keywords: list[str] = []
        publication_name: str | None = None
        language: str | None = None
        if news_el is not None:
            t = news_el.find("news:title", _NS)
            if t is not None and t.text:
                title = t.text.strip()
            pd = news_el.find("news:publication_date", _NS)
            if pd is not None and pd.text:
                published = _parse_iso(pd.text.strip())
            kw = news_el.find("news:keywords", _NS)
            if kw is not None and kw.text:
                keywords = [k.strip() for k in kw.text.split(",") if k.strip()]
            pub = news_el.find("news:publication", _NS)
            if pub is not None:
                n = pub.find("news:name", _NS)
                if n is not None and n.text:
                    publication_name = n.text.strip() or None
                lang = pub.find("news:language", _NS)
                if lang is not None and lang.text:
                    language = lang.text.strip() or None

        if not title:
            # Some publishers omit news:title; fall back to last URL segment.
            title = url.rsplit("/", 1)[-1].replace("-", " ").strip() or "(no title)"
        out.append(SitemapEntry(url, title, published, keywords, publication_name, language))
    return out

    def _to_item(self, entry: SitemapEntry) -> Item:
        # Per-item publication name from the XML wins over the
        # stream-level config; the config value is just a fallback for
        # publishers that omit <news:publication><news:name>.
        publication = entry.publication_name or self.config.publication_name or self.name
        body_lines = [
            f"Publication: {publication}",
            f"Title: {entry.title}",
            f"Published: {entry.published.isoformat() if entry.published else 'unknown'}",
            f"URL: {entry.url}",
        ]
        if entry.language:
            body_lines.append(f"Language: {entry.language}")
        if entry.keywords:
            body_lines.append(f"Keywords: {', '.join(entry.keywords)}")
        return Item(
            id=entry.url,
            source_type="sitemap_news",
            title=entry.title,
            body="\n".join(body_lines) + "\n",
            author=publication,
            url=entry.url,
            received_at=entry.published or utc_now(),
            metadata={
                "stream_name": self.name,
                "publication": publication,
                "language": entry.language,
                "keywords": entry.keywords,
            },
        )


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _looks_gzipped(raw: bytes) -> bool:
    return len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return None
