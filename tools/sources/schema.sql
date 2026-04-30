-- Master Mediacloud source catalog. Re-derivable; safe to delete and re-sync.

CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    notes TEXT,
    platform TEXT,
    source_count INTEGER,
    public INTEGER,
    featured INTEGER,
    managed INTEGER,
    monitored INTEGER,
    upstream_modified_at TEXT,
    last_refreshed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY,
    name TEXT,
    label TEXT,
    homepage TEXT,
    canonical_domain TEXT,
    platform TEXT,
    media_type TEXT,
    primary_language TEXT,
    pub_country TEXT,
    pub_state TEXT,
    stories_per_week INTEGER,
    stories_total INTEGER,
    collection_count INTEGER,
    monitored INTEGER,
    last_story TEXT,
    upstream_created_at TEXT,
    upstream_modified_at TEXT,
    last_rescraped_at TEXT,
    notes TEXT,
    alternative_domains TEXT,  -- JSON array
    last_refreshed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sources_canonical_domain ON sources(canonical_domain);
CREATE INDEX IF NOT EXISTS sources_primary_language ON sources(primary_language);
CREATE INDEX IF NOT EXISTS sources_pub_country ON sources(pub_country);
CREATE INDEX IF NOT EXISTS sources_stories_per_week ON sources(stories_per_week);

-- Source <-> collection edges. Empty in v1 (membership not synced).
CREATE TABLE IF NOT EXISTS source_collections (
    source_id INTEGER NOT NULL,
    collection_id INTEGER NOT NULL,
    PRIMARY KEY (source_id, collection_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    collections_synced INTEGER NOT NULL DEFAULT 0,
    sources_synced INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

-- Validated Google News sitemap URLs discovered per source. Populated
-- by tools.sources.discover_sitemaps. One source can have many rows
-- (e.g. BBC has 3 numbered news shards; Asahi has 8 category sitemaps).
CREATE TABLE IF NOT EXISTS source_sitemaps (
    source_id INTEGER NOT NULL,
    sitemap_url TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- 'news' | 'index' | 'urlset' | 'unknown' | 'error'
    discovered_via TEXT NOT NULL,        -- 'robots' | 'index_walk' | 'common_path'
    http_status INTEGER,
    fresh_entries_24h INTEGER,           -- count of <url> with publication_date in last 24h
    latest_pub_date TEXT,                -- ISO-8601 of newest entry seen
    etag TEXT,
    last_modified TEXT,
    last_checked_at TEXT NOT NULL,
    last_ok_at TEXT,
    error TEXT,
    PRIMARY KEY (source_id, sitemap_url)
);

CREATE INDEX IF NOT EXISTS source_sitemaps_kind ON source_sitemaps(kind);

CREATE TABLE IF NOT EXISTS discovery_runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    sources_checked INTEGER NOT NULL DEFAULT 0,
    news_sitemaps_found INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
