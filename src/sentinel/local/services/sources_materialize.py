"""Materialize Media Cloud sitemap catalog rows into `streams`.

Reads `sources.source_sitemaps` (kind='news', with fresh entries) joined to
`sources.sources`, applies optional filters (language, country, min fresh),
and idempotently upserts one `sitemap_news` row per match into the local
runtime's `streams` table.

A stable naming scheme keeps re-runs idempotent: `src:<canonical_domain>`
when a source has exactly one sitemap, otherwise `src:<canonical_domain>:
<8-char-url-hash>`. The `src:` prefix is reserved so `--prune` can identify
stream rows under this command's control.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Optional

import psycopg
from psycopg.rows import dict_row

from sentinel.core.streams.sitemap_news.config import SitemapNewsStreamConfig

STREAM_NAME_PREFIX = "src:"


@dataclass(frozen=True)
class MaterializeFilter:
    language: Optional[str] = None
    country: Optional[str] = None
    min_fresh: int = 1
    limit: int = 10
    kinds: tuple[str, ...] = ("news",)


@dataclass(frozen=True)
class Candidate:
    source_id: int
    canonical_domain: str
    sitemap_url: str
    fresh_entries_24h: int
    publication_name: str
    primary_language: Optional[str]
    pub_country: Optional[str]

    def stream_name(self, suffix_if_collide: bool) -> str:
        base = f"{STREAM_NAME_PREFIX}{self.canonical_domain}"
        if not suffix_if_collide:
            return base
        h = hashlib.sha1(self.sitemap_url.encode()).hexdigest()[:8]
        return f"{base}:{h}"


@dataclass
class MaterializeResult:
    candidates: list[Candidate]
    to_add: list[str]
    to_update: list[str]
    unchanged: list[str]
    to_prune: list[str]


def select_candidates(conn: psycopg.Connection, flt: MaterializeFilter) -> list[Candidate]:
    """Pick catalog sitemaps that match the filter, ordered by signal."""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT
                ss.source_id,
                ss.sitemap_url,
                ss.fresh_entries_24h,
                s.canonical_domain,
                COALESCE(s.label, s.name, s.canonical_domain) AS publication_name,
                s.primary_language,
                s.pub_country
            FROM sources.source_sitemaps ss
            JOIN sources.sources s ON s.id = ss.source_id
            WHERE ss.kind = ANY(%(kinds)s)
              AND ss.fresh_entries_24h >= %(min_fresh)s
              AND s.canonical_domain IS NOT NULL
              AND (%(language)s::text IS NULL OR s.primary_language = %(language)s)
              AND (%(country)s::text IS NULL OR s.pub_country = %(country)s)
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
            sitemap_url=r["sitemap_url"],
            fresh_entries_24h=r["fresh_entries_24h"] or 0,
            publication_name=r["publication_name"] or r["canonical_domain"],
            primary_language=r["primary_language"],
            pub_country=r["pub_country"],
        )
        for r in rows
    ]


def assign_names(candidates: list[Candidate]) -> dict[Candidate, str]:
    """Resolve stable stream names. Append a URL-hash suffix only when a
    domain has more than one selected sitemap."""
    by_domain: dict[str, int] = {}
    for c in candidates:
        by_domain[c.canonical_domain] = by_domain.get(c.canonical_domain, 0) + 1
    return {
        c: c.stream_name(suffix_if_collide=by_domain[c.canonical_domain] > 1)
        for c in candidates
    }


def _config_payload(c: Candidate) -> str:
    return SitemapNewsStreamConfig(
        sitemap_url=c.sitemap_url,
        publication_name=c.publication_name,
    ).model_dump_json()


def _existing_managed(conn: psycopg.Connection) -> dict[str, dict[str, str]]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            "SELECT name, stream_type, config_json FROM streams "
            "WHERE name LIKE %s",
            (STREAM_NAME_PREFIX + "%",),
        )
        return {r["name"]: r for r in cur.fetchall()}


def plan(conn: psycopg.Connection, flt: MaterializeFilter, prune: bool) -> MaterializeResult:
    candidates = select_candidates(conn, flt)
    names = assign_names(candidates)
    existing = _existing_managed(conn)

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
        elif prior["stream_type"] != "sitemap_news" or prior["config_json"] != payload:
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


def apply(conn: psycopg.Connection, result: MaterializeResult, candidates_by_name: dict[str, Candidate]) -> None:
    """Execute the planned upserts and (optionally) deletes."""
    with conn.cursor() as cur:
        for name in result.to_add + result.to_update:
            c = candidates_by_name[name]
            cur.execute(
                """
                INSERT INTO streams (name, stream_type, config_json, updated_at)
                VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT(name) DO UPDATE SET
                    stream_type = excluded.stream_type,
                    config_json = excluded.config_json,
                    updated_at  = CURRENT_TIMESTAMP
                """,
                (name, "sitemap_news", _config_payload(c)),
            )
        for name in result.to_prune:
            cur.execute("DELETE FROM streams WHERE name = %s", (name,))


def materialize(
    database_url: str,
    flt: MaterializeFilter,
    dry_run: bool = False,
    prune: bool = False,
) -> MaterializeResult:
    with psycopg.connect(database_url) as conn:
        conn.autocommit = True
        result = plan(conn, flt, prune=prune)
        if not dry_run:
            names_to_cand = {assign_names(result.candidates)[c]: c for c in result.candidates}
            apply(conn, result, names_to_cand)
    return result


def format_plan(result: MaterializeResult, dry_run: bool) -> str:
    lines: list[str] = []
    verb = "would" if dry_run else "will"
    lines.append(f"Matched {len(result.candidates)} candidate(s)")
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
                lines.append(f"  {n:<45s} {tag:<10s} fresh={c.fresh_entries_24h:<6d} {c.sitemap_url}")
        lines.append("")
    return "\n".join(lines).rstrip()
