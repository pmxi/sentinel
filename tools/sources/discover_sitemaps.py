"""Walk robots.txt and sitemap indexes for sources from sources.db,
recording validated Google News sitemap URLs in source_sitemaps.

Classification is content-based, not URL-pattern based: a candidate is a
"news" sitemap iff its body parses as a urlset *and* contains at least
one <url> with a <news:news> child in the news namespace. Filename hints
like "/news.xml" are unreliable (Asahi serves news under
sitemap_national.xml, sitemap_business.xml, etc.).

Usage:
    uv run python -m tools.sources.discover_sitemaps --limit 50 --min-spw 50
    uv run python -m tools.sources.discover_sitemaps --domains bbc.com,nytimes.com,lemonde.fr
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import logging
import re
import sys
from dataclasses import dataclass, field

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

import aiohttp

from tools.sources.db import DEFAULT_DB_PATH, open_db

logger = logging.getLogger("discover_sitemaps")

NEWS_NS = "http://www.google.com/schemas/sitemap-news/0.9"
USER_AGENT = "Mozilla/5.0 (compatible; SentinelDiscoveryBot/0.1; news-sitemap-finder)"
HTTP_TIMEOUT = aiohttp.ClientTimeout(total=30)
PER_WALK_DELAY = 1.0
INDEX_CHILD_FETCH_LIMIT = 8

# Index children whose path encodes a year (or year-month) are almost
# always archives of stale content, not the live news sitemap. Deprioritize
# them — they still get fetched if there's room under the per-index cap,
# but news-keyword and plain children come first.
_ARCHIVE_PATH_RE = re.compile(r"(?<![0-9])(?:19|20)\d{2}(?:[-_/]\d{1,2})?(?![0-9])")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def _ns_uri(tag: str) -> str:
    if tag.startswith("{"):
        return tag[1:].split("}", 1)[0]
    return ""


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _looks_gzipped(raw: bytes) -> bool:
    return len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B


def parse_sitemap_lines(robots_text: str) -> list[str]:
    out: list[str] = []
    for line in robots_text.splitlines():
        if "#" in line:
            line = line[: line.index("#")]
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^sitemap\s*:\s*(.+)$", line, flags=re.IGNORECASE)
        if m:
            out.append(m.group(1).strip())
    return out


@dataclass
class FetchResult:
    status: int
    body: bytes
    etag: str | None = None
    last_modified: str | None = None
    error: str | None = None


@dataclass
class SitemapInfo:
    kind: str  # 'news' | 'index' | 'urlset' | 'unknown' | 'error'
    children: list[str] = field(default_factory=list)
    fresh_entries_24h: int = 0
    latest_pub_date: str | None = None
    error: str | None = None


async def fetch(session: aiohttp.ClientSession, url: str) -> FetchResult:
    try:
        async with session.get(url, timeout=HTTP_TIMEOUT, allow_redirects=True) as resp:
            body = await resp.read()
            return FetchResult(
                status=resp.status,
                body=body,
                etag=resp.headers.get("etag"),
                last_modified=resp.headers.get("last-modified"),
            )
    except Exception as exc:
        return FetchResult(status=0, body=b"", error=str(exc))


def classify(body: bytes) -> SitemapInfo:
    if not body:
        return SitemapInfo(kind="error", error="empty body")
    if _looks_gzipped(body):
        try:
            body = gzip.decompress(body)
        except Exception as exc:
            return SitemapInfo(kind="error", error=f"gunzip: {exc}")

    try:
        root = ET.fromstring(body)
    except ET.ParseError as exc:
        return SitemapInfo(kind="error", error=f"xml: {exc}")

    local = _local_name(root.tag)

    if local == "sitemapindex":
        children: list[str] = []
        for sm in root:
            for el in sm:
                if _local_name(el.tag) == "loc" and el.text:
                    children.append(el.text.strip())
                    break
        return SitemapInfo(kind="index", children=children)

    if local != "urlset":
        return SitemapInfo(kind="unknown")

    has_news = False
    fresh_count = 0
    latest: datetime | None = None
    cutoff_24h = datetime.now(timezone.utc) - timedelta(hours=24)

    for url_el in root:
        if _local_name(url_el.tag) != "url":
            continue
        pub_date: datetime | None = None
        for child in url_el:
            if _ns_uri(child.tag) == NEWS_NS and _local_name(child.tag) == "news":
                has_news = True
                for n_child in child:
                    if _local_name(n_child.tag) == "publication_date" and n_child.text:
                        pub_date = _parse_iso(n_child.text.strip())
                        break
                break
        if pub_date:
            if latest is None or pub_date > latest:
                latest = pub_date
            if pub_date >= cutoff_24h:
                fresh_count += 1

    return SitemapInfo(
        kind="news" if has_news else "urlset",
        fresh_entries_24h=fresh_count,
        latest_pub_date=latest.isoformat() if latest else None,
    )


def pick_index_children(children: list[str], max_count: int = INDEX_CHILD_FETCH_LIMIT) -> list[str]:
    """Three-tier ordering. (1) keyword-matching paths first, (2) then
    paths with no archive year, (3) then archive-shaped paths last.
    We don't exclude any tier outright — Asahi has none of the keywords
    yet all 8 children are valid news sitemaps. The cap is applied to
    the merged list."""
    keywords = ("news", "latest", "recent", "current", "headlines", "article")
    matched: list[str] = []
    plain: list[str] = []
    archive: list[str] = []
    for u in children:
        ul = u.lower()
        if _ARCHIVE_PATH_RE.search(ul):
            archive.append(u)
        elif any(k in ul for k in keywords):
            matched.append(u)
        else:
            plain.append(u)
    return (matched + plain + archive)[:max_count]


async def walk_source(
    session: aiohttp.ClientSession,
    source_id: int,
    canonical_domain: str,
) -> list[dict[str, Any]]:
    base = f"https://{canonical_domain}"
    rows: list[dict[str, Any]] = []
    visited: set[str] = set()

    robots_url = f"{base}/robots.txt"
    robots_result = await fetch(session, robots_url)

    if robots_result.status != 200 or not robots_result.body:
        rows.append(
            _row(source_id, robots_url, robots_result, SitemapInfo(kind="error", error=robots_result.error or f"robots http {robots_result.status}"), "robots")
        )
        return rows

    try:
        robots_text = robots_result.body.decode("utf-8", errors="replace")
    except Exception as exc:
        rows.append(_row(source_id, robots_url, robots_result, SitemapInfo(kind="error", error=f"robots decode: {exc}"), "robots"))
        return rows

    declared = parse_sitemap_lines(robots_text)
    if not declared:
        # Walker shouldn't fail silently — record that we looked.
        rows.append(_row(source_id, robots_url, robots_result, SitemapInfo(kind="unknown", error="no Sitemap: lines"), "robots"))
        return rows

    for url in declared:
        if url in visited:
            continue
        visited.add(url)
        await asyncio.sleep(PER_WALK_DELAY)

        result = await fetch(session, url)
        info = classify(result.body) if result.status == 200 else SitemapInfo(
            kind="error", error=result.error or f"http {result.status}"
        )
        rows.append(_row(source_id, url, result, info, "robots"))

        if info.kind == "index":
            for child_url in pick_index_children(info.children):
                if child_url in visited:
                    continue
                visited.add(child_url)
                await asyncio.sleep(PER_WALK_DELAY)
                child_result = await fetch(session, child_url)
                child_info = classify(child_result.body) if child_result.status == 200 else SitemapInfo(
                    kind="error", error=child_result.error or f"http {child_result.status}"
                )
                rows.append(_row(source_id, child_url, child_result, child_info, "index_walk"))

    return rows


def _row(
    source_id: int,
    url: str,
    fetch_result: FetchResult,
    info: SitemapInfo,
    discovered_via: str,
) -> dict[str, Any]:
    now = _now_iso()
    return {
        "source_id": source_id,
        "sitemap_url": url,
        "kind": info.kind,
        "discovered_via": discovered_via,
        "http_status": fetch_result.status or None,
        "fresh_entries_24h": info.fresh_entries_24h,
        "latest_pub_date": info.latest_pub_date,
        "etag": fetch_result.etag,
        "last_modified": fetch_result.last_modified,
        "last_checked_at": now,
        "last_ok_at": now if fetch_result.status == 200 else None,
        "error": info.error or fetch_result.error,
    }


UPSERT_SQL = """
INSERT INTO source_sitemaps
    (source_id, sitemap_url, kind, discovered_via, http_status, fresh_entries_24h,
     latest_pub_date, etag, last_modified, last_checked_at, last_ok_at, error)
VALUES
    (:source_id, :sitemap_url, :kind, :discovered_via, :http_status, :fresh_entries_24h,
     :latest_pub_date, :etag, :last_modified, :last_checked_at, :last_ok_at, :error)
ON CONFLICT(source_id, sitemap_url) DO UPDATE SET
    kind=excluded.kind,
    discovered_via=excluded.discovered_via,
    http_status=excluded.http_status,
    fresh_entries_24h=excluded.fresh_entries_24h,
    latest_pub_date=excluded.latest_pub_date,
    etag=excluded.etag,
    last_modified=excluded.last_modified,
    last_checked_at=excluded.last_checked_at,
    last_ok_at=COALESCE(excluded.last_ok_at, source_sitemaps.last_ok_at),
    error=excluded.error
"""


def select_sources(conn, args) -> list[tuple[int, str]]:
    if args.domains:
        placeholders = ",".join("?" * len(args.domains))
        rows = conn.execute(
            f"""
            SELECT id, canonical_domain FROM sources
            WHERE canonical_domain IN ({placeholders})
              AND stories_per_week IS NOT NULL
            ORDER BY stories_per_week DESC
            """,
            args.domains,
        ).fetchall()
        # Dedup by canonical_domain (catalog has multiple source ids per domain).
        seen: set[str] = set()
        deduped: list[tuple[int, str]] = []
        for r in rows:
            if r["canonical_domain"] in seen:
                continue
            seen.add(r["canonical_domain"])
            deduped.append((r["id"], r["canonical_domain"]))
        return deduped
    rows = conn.execute(
        """
        SELECT id, canonical_domain FROM sources
        WHERE canonical_domain IS NOT NULL
          AND stories_per_week >= ?
        ORDER BY stories_per_week DESC
        LIMIT ?
        """,
        (args.min_spw, args.limit),
    ).fetchall()
    seen = set()
    deduped = []
    for r in rows:
        if r["canonical_domain"] in seen:
            continue
        seen.add(r["canonical_domain"])
        deduped.append((r["id"], r["canonical_domain"]))
    return deduped


async def main_async(args) -> int:
    conn = open_db(DEFAULT_DB_PATH)

    sources = select_sources(conn, args)
    if not sources:
        print("no sources match the filter")
        return 1

    started_at = _now_iso()
    cur = conn.execute("INSERT INTO discovery_runs (started_at) VALUES (?)", (started_at,))
    run_id = cur.lastrowid
    conn.commit()

    logger.info("walking %d sources (concurrency=%d)", len(sources), args.concurrency)

    sem = asyncio.Semaphore(args.concurrency)
    headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "gzip, deflate"}
    connector = aiohttp.TCPConnector(limit=args.concurrency, limit_per_host=1, ttl_dns_cache=300)

    async with aiohttp.ClientSession(headers=headers, connector=connector) as session:
        async def bounded(source_id: int, domain: str) -> list[dict[str, Any]]:
            async with sem:
                try:
                    return await walk_source(session, source_id, domain)
                except Exception as exc:
                    logger.exception("walk crashed for %s", domain)
                    return [{
                        "source_id": source_id,
                        "sitemap_url": f"https://{domain}/robots.txt",
                        "kind": "error",
                        "discovered_via": "robots",
                        "http_status": None,
                        "fresh_entries_24h": 0,
                        "latest_pub_date": None,
                        "etag": None,
                        "last_modified": None,
                        "last_checked_at": _now_iso(),
                        "last_ok_at": None,
                        "error": f"crash: {exc!r}",
                    }]

        tasks = [asyncio.create_task(bounded(sid, dom)) for sid, dom in sources]

        all_rows: list[dict[str, Any]] = []
        for i, coro in enumerate(asyncio.as_completed(tasks), 1):
            walked = await coro
            all_rows.extend(walked)
            if i % 25 == 0 or i == len(tasks):
                logger.info("completed %d/%d", i, len(tasks))

    with conn:
        for row in all_rows:
            conn.execute(UPSERT_SQL, row)

    n_news_fresh = sum(1 for r in all_rows if r["kind"] == "news" and r["fresh_entries_24h"] > 0)
    n_news_any = sum(1 for r in all_rows if r["kind"] == "news")
    n_index = sum(1 for r in all_rows if r["kind"] == "index")
    n_urlset = sum(1 for r in all_rows if r["kind"] == "urlset")
    n_unknown = sum(1 for r in all_rows if r["kind"] == "unknown")
    n_error = sum(1 for r in all_rows if r["kind"] == "error")
    sources_with_news = len({r["source_id"] for r in all_rows if r["kind"] == "news" and r["fresh_entries_24h"] > 0})

    cur = conn.execute(
        "UPDATE discovery_runs SET finished_at=?, sources_checked=?, news_sitemaps_found=? WHERE id=?",
        (_now_iso(), len(sources), n_news_fresh, run_id),
    )
    conn.commit()
    conn.close()

    print()
    print(f"discovery_run_id:        {run_id}")
    print(f"Sources walked:          {len(sources):>6}")
    print(f"Sitemaps recorded:       {len(all_rows):>6}")
    print(f"  news (fresh <24h):     {n_news_fresh:>6}")
    print(f"  news (any age):        {n_news_any:>6}")
    print(f"  sitemap indexes:       {n_index:>6}")
    print(f"  plain urlsets:         {n_urlset:>6}")
    print(f"  unknown roots:         {n_unknown:>6}")
    print(f"  errors:                {n_error:>6}")
    print(f"Sources with >=1 news:   {sources_with_news:>6} ({sources_with_news / len(sources):.0%})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=20, help="max sources to walk (ignored if --domains is set)")
    parser.add_argument("--min-spw", type=int, default=50, help="minimum stories_per_week filter")
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument(
        "--domains",
        type=lambda s: [d.strip() for d in s.split(",") if d.strip()],
        default=None,
        help="explicit comma-separated canonical_domain list (overrides --limit/--min-spw)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
