"""Materialize Media Cloud catalog rows into runtime `streams`.

Two source surfaces feed this command:
  * `sources.source_sitemaps` (kind='news' by default) -> sitemap_news streams
  * `sources.source_feeds`    (kind in {rss, atom, rdf}) -> rss streams

A stable naming scheme keeps re-runs idempotent:
  * sitemap streams:  `src:<canonical_domain>[:<8-char-url-hash>]`
  * RSS feed streams: `src-feed:<canonical_domain>[:<8-char-url-hash>]`

The hash suffix is only appended when a source contributes more than one
matching sitemap (or feed). The `src:` / `src-feed:` prefixes are reserved
so `--prune` can identify stream rows under this command's control.

Poll intervals are bucketed by `stories_per_week` to keep the supervisor's
total poll load reasonable when materializing thousands of streams.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Optional

import psycopg
from psycopg.rows import dict_row

from sentinel.core.streams.rss.config import RSSStreamConfig
from sentinel.core.streams.sitemap_news.config import SitemapNewsStreamConfig

SITEMAP_PREFIX = "src:"
FEED_PREFIX = "src-feed:"


def adaptive_poll_seconds(stories_per_week: Optional[int]) -> int:
    """Bucketed polling cadence. High-volume sources get polled often so we
    don't miss articles inside a single sitemap window; low-volume sources
    are checked less frequently to spare network and CPU."""
    spw = stories_per_week or 0
    if spw >= 500:
        return 120          # 2 min  — top-tier wire (NYT, BBC, ...)
    if spw >= 100:
        return 300          # 5 min
    if spw >= 25:
        return 900          # 15 min
    if spw >= 5:
        return 1800         # 30 min
    return 3600             # 1 hour


@dataclass(frozen=True)
class MaterializeFilter:
    language: Optional[str] = None
    country: Optional[str] = None
    min_fresh: int = 1            # only applies to sitemap selection
    limit: int = 10
    kinds: tuple[str, ...] = ("news",)


@dataclass(frozen=True)
class Candidate:
    source_id: int
    canonical_domain: str
    target_url: str               # sitemap_url or feed_url
    fresh_entries_24h: int        # 0 for feeds (no equivalent column)
    stories_per_week: Optional[int]
    publication_name: str
    primary_language: Optional[str]
    pub_country: Optional[str]
    stream_type: str              # 'sitemap_news' | 'rss'

    @property
    def name_prefix(self) -> str:
        return SITEMAP_PREFIX if self.stream_type == "sitemap_news" else FEED_PREFIX

    def stream_name(self, suffix_if_collide: bool) -> str:
        base = f"{self.name_prefix}{self.canonical_domain}"
        if not suffix_if_collide:
            return base
        h = hashlib.sha1(self.target_url.encode()).hexdigest()[:8]
        return f"{base}:{h}"


@dataclass
class MaterializeResult:
    candidates: list[Candidate]
    to_add: list[str]
    to_update: list[str]
    unchanged: list[str]
    to_prune: list[str]


def _select_sitemap_candidates(conn: psycopg.Connection, flt: MaterializeFilter) -> list[Candidate]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT
                ss.source_id,
                ss.sitemap_url AS target_url,
                ss.fresh_entries_24h,
                s.canonical_domain,
                s.stories_per_week,
                COALESCE(s.label, s.name, s.canonical_domain) AS publication_name,
                s.primary_language,
                s.pub_country
            FROM sources.source_sitemaps ss
            JOIN sources.sources s ON s.id = ss.source_id
            WHERE ss.kind = ANY(%(kinds)s)
              AND ss.fresh_entries_24h >= %(min_fresh)s
              AND s.canonical_domain IS NOT NULL
              AND (%(language)s::text IS NULL OR s.primary_language = %(language)s)
              AND (%(country)s::text  IS NULL OR s.pub_country = %(country)s)
            ORDER BY ss.fresh_entries_24h DESC, ss.sitemap_url
            LIMIT %(limit)s
            """,
            {
                "kinds": list(flt.kinds),
                "min_fresh": flt.min_fresh,
                "language": flt.language,
                "country": flt.country,
                "limit": flt.limit,
            },
        )
        rows = cur.fetchall()
    return [
        Candidate(
            source_id=r["source_id"],
            canonical_domain=r["canonical_domain"],
            target_url=r["target_url"],
            fresh_entries_24h=r["fresh_entries_24h"] or 0,
            stories_per_week=r["stories_per_week"],
            publication_name=r["publication_name"] or r["canonical_domain"],
            primary_language=r["primary_language"],
            pub_country=r["pub_country"],
            stream_type="sitemap_news",
        )
        for r in rows
    ]


def _select_feed_candidates(conn: psycopg.Connection, flt: MaterializeFilter) -> list[Candidate]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT
                sf.source_id,
                sf.feed_url AS target_url,
                s.canonical_domain,
                s.stories_per_week,
                COALESCE(sf.title, s.label, s.name, s.canonical_domain) AS publication_name,
                s.primary_language,
                s.pub_country
            FROM sources.source_feeds sf
            JOIN sources.sources s ON s.id = sf.source_id
            WHERE sf.kind IN ('rss', 'atom', 'rdf')
              AND s.canonical_domain IS NOT NULL
              AND (%(language)s::text IS NULL OR s.primary_language = %(language)s)
              AND (%(country)s::text  IS NULL OR s.pub_country = %(country)s)
            ORDER BY s.stories_per_week DESC NULLS LAST, sf.feed_url
            LIMIT %(limit)s
            """,
            {
                "language": flt.language,
                "country": flt.country,
                "limit": flt.limit,
            },
        )
        rows = cur.fetchall()
    return [
        Candidate(
            source_id=r["source_id"],
            canonical_domain=r["canonical_domain"],
            target_url=r["target_url"],
            fresh_entries_24h=0,
            stories_per_week=r["stories_per_week"],
            publication_name=r["publication_name"] or r["canonical_domain"],
            primary_language=r["primary_language"],
            pub_country=r["pub_country"],
            stream_type="rss",
        )
        for r in rows
    ]


def assign_names(candidates: list[Candidate]) -> dict[Candidate, str]:
    """Stable name assignment. Append URL-hash suffix only when a (domain,
    stream_type) pair has more than one matching candidate."""
    bucket: dict[tuple[str, str], int] = {}
    for c in candidates:
        key = (c.canonical_domain, c.stream_type)
        bucket[key] = bucket.get(key, 0) + 1
    return {
        c: c.stream_name(suffix_if_collide=bucket[(c.canonical_domain, c.stream_type)] > 1)
        for c in candidates
    }


def _config_payload(c: Candidate) -> str:
    poll = adaptive_poll_seconds(c.stories_per_week)
    if c.stream_type == "sitemap_news":
        cfg = SitemapNewsStreamConfig(
            sitemap_url=c.target_url,
            publication_name=c.publication_name,
            poll_seconds=poll,
        )
    else:
        cfg = RSSStreamConfig(
            feed_url=c.target_url,
            poll_seconds=poll,
        )
    return cfg.model_dump_json()


def _existing_managed(conn: psycopg.Connection, prefixes: tuple[str, ...]) -> dict[str, dict[str, str]]:
    with conn.cursor(row_factory=dict_row) as cur:
        sql = " UNION ALL ".join(
            "SELECT name, stream_type, config_json FROM streams WHERE name LIKE %s"
            for _ in prefixes
        )
        cur.execute(sql, [p + "%" for p in prefixes])
        return {r["name"]: r for r in cur.fetchall()}


def plan(
    conn: psycopg.Connection,
    flt: MaterializeFilter,
    include_sitemaps: bool,
    include_feeds: bool,
    prune: bool,
) -> MaterializeResult:
    candidates: list[Candidate] = []
    if include_sitemaps:
        candidates.extend(_select_sitemap_candidates(conn, flt))
    if include_feeds:
        candidates.extend(_select_feed_candidates(conn, flt))

    names = assign_names(candidates)

    active_prefixes: list[str] = []
    if include_sitemaps:
        active_prefixes.append(SITEMAP_PREFIX)
    if include_feeds:
        active_prefixes.append(FEED_PREFIX)
    existing = _existing_managed(conn, tuple(active_prefixes)) if active_prefixes else {}

    to_add: list[str] = []
    to_update: list[str] = []
    unchanged: list[str] = []
    desired_names: set[str] = set()

    for c in candidates:
        name = names[c]
        desired_names.add(name)
        payload = _config_payload(c)
        prior = existing.get(name)
        if prior is None:
            to_add.append(name)
        elif prior["stream_type"] != c.stream_type or prior["config_json"] != payload:
            to_update.append(name)
        else:
            unchanged.append(name)

    to_prune: list[str] = sorted(set(existing) - desired_names) if prune else []
    return MaterializeResult(
        candidates=candidates,
        to_add=sorted(to_add),
        to_update=sorted(to_update),
        unchanged=sorted(unchanged),
        to_prune=to_prune,
    )


def apply(conn: psycopg.Connection, result: MaterializeResult) -> None:
    names_to_cand = {assign_names(result.candidates)[c]: c for c in result.candidates}
    with conn.cursor() as cur:
        for name in result.to_add + result.to_update:
            c = names_to_cand[name]
            cur.execute(
                """
                INSERT INTO streams (name, stream_type, config_json, updated_at)
                VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT(name) DO UPDATE SET
                    stream_type = excluded.stream_type,
                    config_json = excluded.config_json,
                    updated_at  = CURRENT_TIMESTAMP
                """,
                (name, c.stream_type, _config_payload(c)),
            )
        for name in result.to_prune:
            cur.execute("DELETE FROM streams WHERE name = %s", (name,))


def materialize(
    database_url: str,
    flt: MaterializeFilter,
    include_sitemaps: bool = True,
    include_feeds: bool = True,
    dry_run: bool = False,
    prune: bool = False,
) -> MaterializeResult:
    with psycopg.connect(database_url) as conn:
        conn.autocommit = True
        result = plan(conn, flt, include_sitemaps=include_sitemaps,
                      include_feeds=include_feeds, prune=prune)
        if not dry_run:
            apply(conn, result)
    return result


def format_plan(result: MaterializeResult, dry_run: bool) -> str:
    lines: list[str] = []
    verb = "would" if dry_run else "will"
    sitemap_count = sum(1 for c in result.candidates if c.stream_type == "sitemap_news")
    feed_count = sum(1 for c in result.candidates if c.stream_type == "rss")
    lines.append(f"Matched {len(result.candidates)} candidate(s)  (sitemaps={sitemap_count}, rss={feed_count})")
    lines.append(f"  {verb} add:       {len(result.to_add)}")
    lines.append(f"  {verb} update:    {len(result.to_update)}")
    lines.append(f"  unchanged:     {len(result.unchanged)}")
    if result.to_prune:
        lines.append(f"  {verb} prune:     {len(result.to_prune)}")
    lines.append("")
    by_name = {assign_names(result.candidates)[c]: c for c in result.candidates}
    for kind, names in (("ADD", result.to_add), ("UPDATE", result.to_update), ("PRUNE", result.to_prune)):
        if not names:
            continue
        lines.append(f"[{kind}]")
        for n in names:
            c = by_name.get(n)
            if c is None:
                lines.append(f"  {n}")
            else:
                tag = f"{c.primary_language or '?'}/{c.pub_country or '?'}"
                poll = adaptive_poll_seconds(c.stories_per_week)
                lines.append(
                    f"  {n:<55s} {c.stream_type:<14s} {tag:<10s} "
                    f"spw={c.stories_per_week or 0:<5d} poll={poll}s  {c.target_url}"
                )
        lines.append("")
    return "\n".join(lines).rstrip()
