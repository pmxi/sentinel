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
