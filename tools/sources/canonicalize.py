"""Normalize publisher homepage URLs to a canonical domain for dedup.

Mediacloud lists the same outlet under several URL variants
(`http://example.com`, `https://www.example.com/`, port-suffixed forms).
Collapsing these to a single key removes ~15-20% of the catalog.
"""

from __future__ import annotations

from urllib.parse import urlparse


def canonical_domain(homepage: str | None) -> str | None:
    if not homepage:
        return None
    raw = homepage.strip()
    if not raw:
        return None
    # urlparse needs a scheme to populate netloc; assume http if missing.
    if "://" not in raw:
        raw = "http://" + raw
    parsed = urlparse(raw)
    host = parsed.hostname  # already lowercased and port-stripped
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    return host or None
