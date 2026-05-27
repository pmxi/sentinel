"""Walk publisher homepages for RSS/Atom feeds and validate them.

Per source, in order:
  1. Fetch homepage HTML; parse <link rel="alternate" type="application/(rss|atom|rdf)+xml">
  2. If no links found, probe common paths (/feed, /rss, /feed.xml, /atom.xml, /index.xml)
  3. Optionally fall back to Media Cloud feed_list (one API call per source)

A candidate URL is only persisted to sources.source_feed after a fetch
returns a body that feedparser can parse as RSS / Atom / RDF.

Usage:
    uv run python -m tools.sources.discover_feeds --limit 100 --min-spw 100
    uv run python -m tools.sources.discover_feeds --domains bbc.com,nytimes.com
    MEDIACLOUD_API_KEY=... uv run python -m tools.sources.discover_feeds \
        --limit 10000 --min-spw 100 --concurrency 100 --mediacloud-fallback
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp
import feedparser

from tools.sources.db import open_db

logger = logging.getLogger("discover_feeds")

USER_AGENT = "Mozilla/5.0 (compatible; SentinelDiscoveryBot/0.1; rss-feed-finder)"
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=20)
PER_HOST_DELAY = 1.0

COMMON_PATHS = ("/feed", "/rss", "/feed.xml", "/atom.xml", "/index.xml", "/rss.xml", "/feeds/posts/default")

FEED_TYPES = {
    "application/rss+xml": "rss",
    "application/atom+xml": "atom",
    "application/rdf+xml": "rdf",
    "application/xml": "rss",  # ambiguous; treat as rss candidate
    "text/xml": "rss",          # same
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _looks_gzipped(raw: bytes) -> bool:
    return len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B


@dataclass
class FetchResult:
    status: int
    body: bytes
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None


@dataclass
class FeedInfo:
    """Result of validating a candidate feed URL."""
    kind: str                    # 'rss' | 'atom' | 'rdf' | 'error'
    title: str | None = None
    latest_entry_date: str | None = None
    entries_seen: int = 0
    error: str | None = None


@dataclass
class DiscoveredFeed:
    url: str
    discovered_via: str          # 'homepage_link' | 'common_path' | 'mediacloud'
    fetch: FetchResult
    info: FeedInfo


class _LinkExtractor(HTMLParser):
    """Pulls <link rel="alternate" type="application/(rss|atom|rdf)+xml" href=...>
    declarations out of the <head>. Stops scanning at </head> to avoid wasted
    parsing on large article bodies."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []  # (type, href)
        self.in_head = False
        self._stopped = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._stopped:
            return
        t = tag.lower()
        if t == "head":
            self.in_head = True
            return
        if not self.in_head:
            return
        if t != "link":
            return
        attr = {k.lower(): (v or "") for k, v in attrs}
        rel = attr.get("rel", "").lower()
        if "alternate" not in rel.split():
            return
        type_ = attr.get("type", "").lower()
        href = attr.get("href", "")
        if not href or type_ not in FEED_TYPES:
            return
        self.links.append((type_, href))

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "head":
            self._stopped = True


def extract_link_candidates(html_bytes: bytes, base_url: str) -> list[tuple[str, str]]:
    """Returns [(declared_type, absolute_url), ...]. Robust to malformed HTML."""
    try:
        text = html_bytes.decode("utf-8", errors="replace")
    except Exception:
        return []
    parser = _LinkExtractor()
    try:
        parser.feed(text)
    except Exception as exc:
        logger.debug("html parse error: %s", exc)
    out: list[tuple[str, str]] = []
    for type_, href in parser.links:
        abs_url = urljoin(base_url, href.strip())
        if abs_url.startswith(("http://", "https://")):
            out.append((type_, abs_url))
    # Dedup while preserving order
    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for t, u in out:
        if u in seen:
            continue
        seen.add(u)
        deduped.append((t, u))
    return deduped


async def fetch(session: aiohttp.ClientSession, url: str, timeout: aiohttp.ClientTimeout = HTTP_TIMEOUT) -> FetchResult:
    try:
        async with session.get(url, timeout=timeout, allow_redirects=True) as resp:
            body = await resp.read()
            return FetchResult(
                status=resp.status,
                body=body,
                etag=resp.headers.get("etag"),
                last_modified=resp.headers.get("last-modified"),
            )
    except Exception as exc:
        return FetchResult(status=0, body=b"", error=str(exc))


def validate_feed(raw: bytes) -> FeedInfo:
    """Parse bytes via feedparser; classify and pull a few metadata fields."""
    if not raw:
        return FeedInfo(kind="error", error="empty body")
    if _looks_gzipped(raw):
        try:
            raw = gzip.decompress(raw)
        except Exception as exc:
            return FeedInfo(kind="error", error=f"gunzip: {exc}")
    parsed = feedparser.parse(raw)
    # `bozo` is feedparser's "this was malformed" flag, but it fires for
    # tons of legitimate feeds (charset hiccups, etc). The real signal is
    # whether there's a feed.version and at least one entry.
    version = (parsed.get("version") or "").strip()
    entries = parsed.get("entries") or []
    if not version and not entries:
        return FeedInfo(
            kind="error",
            error=str(parsed.bozo_exception) if getattr(parsed, "bozo_exception", None) else "not a feed",
        )
    kind = "rss"
    if version.startswith("atom"):
        kind = "atom"
    elif version.startswith("rss") or version.startswith("rdf"):
        kind = "rdf" if version.startswith("rdf") else "rss"
    title = (parsed.feed.get("title") if parsed.feed else None) or None
    latest = None
    for e in entries[:50]:
        when = e.get("published_parsed") or e.get("updated_parsed")
        if not when:
            continue
        try:
            dt = datetime(*when[:6], tzinfo=timezone.utc).isoformat()
        except Exception:
            continue
        if latest is None or dt > latest:
            latest = dt
    return FeedInfo(kind=kind, title=title, latest_entry_date=latest, entries_seen=len(entries))


async def discover_for_source(
    session: aiohttp.ClientSession,
    source_id: int,
    homepage: str,
    mc_fallback: "MediacloudFeedFetcher | None",
) -> list[DiscoveredFeed]:
    """Try homepage → common paths → MC fallback. Returns validated feeds."""
    found: list[DiscoveredFeed] = []
    seen_urls: set[str] = set()

    if not homepage:
        return found

    # 1. Homepage HTML <link rel="alternate">
    home = await fetch(session, homepage)
    if home.status == 200 and home.body:
        for _type, candidate_url in extract_link_candidates(home.body, homepage):
            if candidate_url in seen_urls:
                continue
            seen_urls.add(candidate_url)
            await asyncio.sleep(PER_HOST_DELAY)
            fr = await fetch(session, candidate_url)
            if fr.status == 200:
                info = validate_feed(fr.body)
            else:
                info = FeedInfo(kind="error", error=fr.error or f"http {fr.status}")
            if info.kind != "error":
                found.append(DiscoveredFeed(candidate_url, "homepage_link", fr, info))

    # 2. Common paths only if no validated feeds yet
    if not found:
        parsed = urlparse(homepage)
        base = f"{parsed.scheme}://{parsed.netloc}"
        for path in COMMON_PATHS:
            url = base + path
            if url in seen_urls:
                continue
            seen_urls.add(url)
            await asyncio.sleep(PER_HOST_DELAY)
            fr = await fetch(session, url)
            if fr.status != 200:
                continue
            info = validate_feed(fr.body)
            if info.kind != "error":
                found.append(DiscoveredFeed(url, "common_path", fr, info))
                break  # one common-path feed is enough; rest is noise

    # 3. Mediacloud fallback as last resort
    if not found and mc_fallback is not None:
        try:
            mc_urls = await mc_fallback.feeds_for(source_id)
        except Exception as exc:
            logger.warning("mediacloud feed_list for source %d failed: %s", source_id, exc)
            mc_urls = []
        for url in mc_urls:
            if url in seen_urls:
                continue
            seen_urls.add(url)
            await asyncio.sleep(PER_HOST_DELAY)
            fr = await fetch(session, url)
            if fr.status != 200:
                continue
            info = validate_feed(fr.body)
            if info.kind != "error":
                found.append(DiscoveredFeed(url, "mediacloud", fr, info))

    return found


class MediacloudFeedFetcher:
    """Thin wrapper that uses tools.sources.client.MediacloudClient and
    runs the sync API call in a thread to avoid blocking the event loop."""

    def __init__(self) -> None:
        from tools.sources.client import MediacloudClient
        self.client = MediacloudClient()

    async def feeds_for(self, source_id: int) -> list[str]:
        loop = asyncio.get_running_loop()
        page = await loop.run_in_executor(
            None,
            lambda: self.client.api.feed_list(source_id=source_id, return_details=True, limit=50),
        )
        out: list[str] = []
        for f in page.get("results", []):
            u = (f.get("url") or "").strip()
            if u.startswith(("http://", "https://")):
                out.append(u)
        return out


UPSERT_SQL = """
INSERT INTO source_feed
    (source_id, feed_url, kind, discovered_via, http_status, title,
     latest_entry_date, entries_seen, etag, last_modified,
     last_checked_at, last_ok_at, error)
VALUES
    (%(source_id)s, %(feed_url)s, %(kind)s, %(discovered_via)s, %(http_status)s,
     %(title)s, %(latest_entry_date)s, %(entries_seen)s, %(etag)s, %(last_modified)s,
     %(last_checked_at)s, %(last_ok_at)s, %(error)s)
ON CONFLICT(source_id, feed_url) DO UPDATE SET
    kind = excluded.kind,
    discovered_via = excluded.discovered_via,
    http_status = excluded.http_status,
    title = excluded.title,
    latest_entry_date = excluded.latest_entry_date,
    entries_seen = excluded.entries_seen,
    etag = excluded.etag,
    last_modified = excluded.last_modified,
    last_checked_at = excluded.last_checked_at,
    last_ok_at = COALESCE(excluded.last_ok_at, source_feed.last_ok_at),
    error = excluded.error
"""


def _row(source_id: int, df: DiscoveredFeed) -> dict[str, Any]:
    now = _now_iso()
    return {
        "source_id": source_id,
        "feed_url": df.url,
        "kind": df.info.kind,
        "discovered_via": df.discovered_via,
        "http_status": df.fetch.status or None,
        "title": df.info.title,
        "latest_entry_date": df.info.latest_entry_date,
        "entries_seen": df.info.entries_seen or None,
        "etag": df.fetch.etag,
        "last_modified": df.fetch.last_modified,
        "last_checked_at": now,
        "last_ok_at": now if df.fetch.status == 200 else None,
        "error": df.info.error or df.fetch.error,
    }


def select_sources(conn, args) -> list[tuple[int, str]]:
    with conn.cursor() as cur:
        if args.domains:
            cur.execute(
                """
                SELECT id, canonical_domain, homepage FROM source
                WHERE canonical_domain = ANY(%s)
                  AND homepage IS NOT NULL
                ORDER BY stories_per_week DESC NULLS LAST
                """,
                (args.domains,),
            )
        else:
            cur.execute(
                """
                SELECT id, canonical_domain, homepage FROM source
                WHERE homepage IS NOT NULL
                  AND canonical_domain IS NOT NULL
                  AND stories_per_week >= %s
                ORDER BY stories_per_week DESC
                LIMIT %s
                """,
                (args.min_spw, args.limit),
            )
        rows = cur.fetchall()
    seen: set[str] = set()
    out: list[tuple[int, str]] = []
    for r in rows:
        dom = r["canonical_domain"]
        if dom in seen:
            continue
        seen.add(dom)
        out.append((r["id"], r["homepage"]))
    return out


async def main_async(args) -> int:
    conn = open_db()

    sources = select_sources(conn, args)
    if not sources:
        print("no sources match the filter")
        return 1

    started_at = _now_iso()
    row = conn.execute(
        "INSERT INTO feed_discovery_run (started_at) VALUES (%s) RETURNING id",
        (started_at,),
    ).fetchone()
    run_id = row["id"]

    mc_fallback: MediacloudFeedFetcher | None = None
    if args.mediacloud_fallback:
        if not os.environ.get("MEDIACLOUD_API_KEY"):
            print("--mediacloud-fallback requested but MEDIACLOUD_API_KEY is unset; disabling", file=sys.stderr)
        else:
            try:
                mc_fallback = MediacloudFeedFetcher()
                logger.info("mediacloud fallback enabled")
            except Exception as exc:
                logger.warning("could not init MC fallback: %s", exc)

    logger.info("walking %d sources (concurrency=%d, mc_fallback=%s)",
                len(sources), args.concurrency, mc_fallback is not None)

    sem = asyncio.Semaphore(args.concurrency)
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"}
    connector = aiohttp.TCPConnector(limit=args.concurrency * 2, limit_per_host=1, ttl_dns_cache=300)

    pairs: list[tuple[int, list[DiscoveredFeed]]] = []
    mc_fallback_count = 0
    error_count = 0

    async with aiohttp.ClientSession(headers=headers, connector=connector) as session:
        async def bounded(source_id: int, homepage: str) -> tuple[int, list[DiscoveredFeed]]:
            async with sem:
                try:
                    feeds = await discover_for_source(session, source_id, homepage, mc_fallback)
                    return source_id, feeds
                except Exception as exc:
                    logger.exception("discover crashed for source %d (%s)", source_id, homepage)
                    return source_id, []

        tasks = [asyncio.create_task(bounded(sid, hp)) for sid, hp in sources]
        completed = 0
        for coro in asyncio.as_completed(tasks):
            sid, feeds = await coro
            pairs.append((sid, feeds))
            for df in feeds:
                if df.discovered_via == "mediacloud":
                    mc_fallback_count += 1
            completed += 1
            if completed % 100 == 0 or completed == len(tasks):
                feeds_so_far = sum(len(p[1]) for p in pairs)
                logger.info("completed %d/%d (validated feeds so far: %d, mc fallbacks: %d)",
                            completed, len(tasks), feeds_so_far, mc_fallback_count)

    # Persist
    total_feeds = 0
    with conn.cursor() as cur:
        for sid, feeds in pairs:
            for df in feeds:
                cur.execute(UPSERT_SQL, _row(sid, df))
                total_feeds += 1

    conn.execute(
        "UPDATE feed_discovery_run SET finished_at=%s, sources_checked=%s, "
        "feeds_found=%s, mediacloud_fallbacks=%s WHERE id=%s",
        (_now_iso(), len(sources), total_feeds, mc_fallback_count, run_id),
    )
    conn.close()

    sources_with_feed = sum(1 for _, feeds in pairs if feeds)
    n_homepage = sum(1 for _, feeds in pairs for df in feeds if df.discovered_via == "homepage_link")
    n_common = sum(1 for _, feeds in pairs for df in feeds if df.discovered_via == "common_path")
    n_mc = sum(1 for _, feeds in pairs for df in feeds if df.discovered_via == "mediacloud")
    print()
    print(f"feed_discovery_run_id:    {run_id}")
    print(f"Sources walked:           {len(sources):>6}")
    print(f"Sources with >=1 feed:    {sources_with_feed:>6} ({sources_with_feed / len(sources):.0%})")
    print(f"Validated feeds total:    {total_feeds:>6}")
    print(f"  via homepage_link:      {n_homepage:>6}")
    print(f"  via common_path:        {n_common:>6}")
    print(f"  via mediacloud:         {n_mc:>6}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=20, help="max sources to walk (ignored if --domains)")
    parser.add_argument("--min-spw", type=int, default=50, help="minimum stories_per_week")
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument(
        "--domains",
        type=lambda s: [d.strip() for d in s.split(",") if d.strip()],
        default=None,
        help="comma-separated canonical_domain list (overrides --limit/--min-spw)",
    )
    parser.add_argument(
        "--mediacloud-fallback",
        action="store_true",
        help="If local discovery yields nothing, fall back to MC feed_list. "
             "Requires MEDIACLOUD_API_KEY in env.",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
