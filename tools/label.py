"""One-off labeling tool for the news classifier.

Standalone Flask app — does NOT touch the main web UI. Reads candidate
items from the runtime DB's live_events table, writes labels to a
separate labels DB so the runtime can never accidentally touch them.

    uv run python tools/label.py --port 8767

Then open http://127.0.0.1:8767 and press J / K / Space.

Stop with Ctrl-C. Throw the script away when you're done collecting labels —
the labeling_examples table in sentinel-labels.db is what matters.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request


PER_SOURCE_BACKFILL_CAP = 500  # most recent N per source pulled in for labeling


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>label</title>
<style>
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  .progress { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
  .source { color: #888; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .title { font-size: 1.4rem; font-weight: 600; margin: 0.3rem 0 0.6rem; }
  .meta { color: #666; font-size: 0.85rem; margin-bottom: 1.2rem; }
  .meta a { color: #06c; }
  .body { white-space: pre-wrap; padding: 0.8rem; background: #f6f6f6; border-radius: 4px; min-height: 2rem; font-size: 0.95rem; }
  .keys { margin-top: 1.5rem; color: #888; font-size: 0.85rem; }
  kbd { background: #eee; border: 1px solid #ccc; padding: 0.05rem 0.4rem; border-radius: 3px; font-family: monospace; font-size: 0.85rem; }
  .empty { color: #888; font-style: italic; padding: 2rem; text-align: center; }
  .last { color: #888; font-size: 0.8rem; margin-top: 0.4rem; }
</style>
</head>
<body>
<div id="progress" class="progress"></div>
<div id="card"></div>
<div id="last" class="last"></div>
<div class="keys">
  <kbd>J</kbd> news &nbsp;
  <kbd>K</kbd> not news &nbsp;
  <kbd>Space</kbd> skip &nbsp;
  <kbd>Z</kbd> undo
</div>
<script>
let state = {item: null, stats: null};
let lastId = null;

async function loadNext() {
  const r = await fetch('/api/next');
  state = await r.json();
  render();
}

function render() {
  const card = document.getElementById('card');
  const prog = document.getElementById('progress');
  const last = document.getElementById('last');
  prog.textContent = `labeled ${state.stats.labeled} / total ${state.stats.total} · positives ${state.stats.positives} (${state.stats.pos_pct}%) · remaining ${state.stats.remaining}`;
  last.textContent = lastId ? `last labeled  — press Z to undo` : '';
  if (!state.item) {
    card.innerHTML = '<div class="empty">No more items to label. Done!</div>';
    return;
  }
  const i = state.item;
  const url = i.url ? `<a href="${i.url}" target="_blank" rel="noopener">open ↗</a>` : '';
  card.innerHTML = `
    <div class="source">${esc(i.source_type)}${i.stream_name ? ' · ' + esc(i.stream_name) : ''}</div>
    <div class="title">${esc(i.title || '(no title)')}</div>
    <div class="meta">${esc(i.author || '')}${i.received_at ? ' · ' + esc(i.received_at) : ''} ${url}</div>
    <div class="body">${esc(i.body || '')}</div>
  `;
}

function esc(s) {
  return (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function submit(label) {
  if (!state.item) return;
  lastId = state.item.token;
  await fetch('/api/label', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: state.item.token, label}),
  });
  await loadNext();
}

async function undo() {
  if (!lastId) return;
  await fetch('/api/undo', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: lastId}),
  });
  lastId = null;
  await loadNext();
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'j' || e.key === 'J') { e.preventDefault(); submit('news'); }
  else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); submit('not_news'); }
  else if (e.key === ' ') { e.preventDefault(); submit('skip'); }
  else if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
});

loadNext();
</script>
</body>
</html>
"""


def open_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS labeling_examples (
                item_id     TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                stream_name TEXT,
                title       TEXT,
                body        TEXT,
                author      TEXT,
                url         TEXT,
                received_at TEXT,
                label       TEXT,
                labeled_at  TEXT
            )
            """
        )


def backfill(conn: sqlite3.Connection, source_db: Path) -> int:
    """Pull recent items from the runtime DB's live_events into our labels DB.

    Newest first within each source, capped per source. Idempotent: INSERT OR
    IGNORE means re-running never duplicates or overwrites labels.
    """
    src = sqlite3.connect(str(source_db))
    src.row_factory = sqlite3.Row
    try:
        rows = src.execute(
            "SELECT payload_json FROM live_events WHERE event_type = 'item_received' ORDER BY id DESC"
        ).fetchall()
    finally:
        src.close()
    by_source: dict[str, list[dict]] = {}
    for row in rows:
        try:
            p = json.loads(row["payload_json"])
        except Exception:
            continue
        if not p.get("item_id"):
            continue
        src = p.get("source_type") or "unknown"
        bucket = by_source.setdefault(src, [])
        if len(bucket) < PER_SOURCE_BACKFILL_CAP:
            bucket.append(p)

    before = conn.execute("SELECT COUNT(*) AS n FROM labeling_examples").fetchone()["n"]
    with conn:
        for src, items in by_source.items():
            for p in items:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO labeling_examples
                        (item_id, source_type, stream_name, title, body, author, url, received_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        p["item_id"],
                        p["source_type"],
                        p.get("stream_name"),
                        p.get("title") or "",
                        "",
                        p.get("author"),
                        p.get("url"),
                        p.get("received_at"),
                    ),
                )
    after = conn.execute("SELECT COUNT(*) AS n FROM labeling_examples").fetchone()["n"]
    return after - before


def stats(conn: sqlite3.Connection) -> dict:
    total = conn.execute("SELECT COUNT(*) AS n FROM labeling_examples").fetchone()["n"]
    labeled = conn.execute(
        "SELECT COUNT(*) AS n FROM labeling_examples WHERE label IS NOT NULL"
    ).fetchone()["n"]
    pos = conn.execute(
        "SELECT COUNT(*) AS n FROM labeling_examples WHERE label = 'news'"
    ).fetchone()["n"]
    pos_pct = round(100 * pos / labeled, 1) if labeled else 0.0
    return {
        "total": total,
        "labeled": labeled,
        "positives": pos,
        "pos_pct": pos_pct,
        "remaining": total - labeled,
    }


def next_item(conn: sqlite3.Connection) -> dict | None:
    """Round-robin through sources so you don't see 100 of the same kind in a row."""
    sources = [
        r["source_type"]
        for r in conn.execute(
            """
            SELECT source_type FROM labeling_examples
            WHERE label IS NULL
            GROUP BY source_type
            ORDER BY MAX(rowid) DESC
            """
        ).fetchall()
    ]
    if not sources:
        return None
    # Pick the source with the fewest already-labeled items so coverage stays balanced.
    counts = {
        r["source_type"]: r["n"]
        for r in conn.execute(
            "SELECT source_type, COUNT(*) AS n FROM labeling_examples WHERE label IS NOT NULL GROUP BY source_type"
        ).fetchall()
    }
    pick = min(sources, key=lambda s: counts.get(s, 0))
    row = conn.execute(
        """
        SELECT rowid, item_id, source_type, stream_name, title, body, author, url, received_at
        FROM labeling_examples
        WHERE label IS NULL AND source_type = ?
        ORDER BY received_at DESC
        LIMIT 1
        """,
        (pick,),
    ).fetchone()
    return dict(row) if row else None


def build_app(conn: sqlite3.Connection, lock: threading.Lock) -> Flask:
    app = Flask(__name__)

    @app.route("/")
    def index():
        return HTML

    @app.route("/api/next")
    def api_next():
        with lock:
            item = next_item(conn)
            payload = (
                {
                    "token": item["rowid"],
                    "title": item["title"],
                    "body": item["body"],
                    "source_type": item["source_type"],
                    "stream_name": item["stream_name"],
                    "author": item["author"],
                    "url": item["url"],
                    "received_at": item["received_at"],
                }
                if item
                else None
            )
            return jsonify({"item": payload, "stats": stats(conn)})

    @app.route("/api/label", methods=["POST"])
    def api_label():
        data = request.get_json(force=True) or {}
        token = data.get("token")
        label = data.get("label")
        if label not in {"news", "not_news", "skip"}:
            return jsonify({"error": "bad label"}), 400
        stored = None if label == "skip" else label
        with lock, conn:
            conn.execute(
                "UPDATE labeling_examples SET label = ?, labeled_at = ?, labeled_by = 'paras' WHERE rowid = ?",
                (stored, datetime.now(timezone.utc).isoformat(timespec="seconds"), token),
            )
        return jsonify({"ok": True})

    @app.route("/api/undo", methods=["POST"])
    def api_undo():
        data = request.get_json(force=True) or {}
        token = data.get("token")
        with lock, conn:
            conn.execute(
                "UPDATE labeling_examples SET label = NULL, labeled_at = NULL, labeled_by = NULL WHERE rowid = ?",
                (token,),
            )
        return jsonify({"ok": True})

    return app


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--db",
        default="sentinel-labels.db",
        help="path to the labels DB (created if missing)",
    )
    p.add_argument(
        "--source-db",
        default="sentinel-local.db",
        help="path to the runtime DB to read live_events from for backfill",
    )
    p.add_argument("--port", type=int, default=8767)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

    labels_path = Path(args.db).resolve()
    source_path = Path(args.source_db).resolve()
    if not source_path.exists():
        raise SystemExit(f"source db not found: {source_path}")
    print(f"labels db: {labels_path}")
    print(f"source db: {source_path}")

    conn = open_db(labels_path)
    ensure_schema(conn)
    added = backfill(conn, source_path)
    s = stats(conn)
    print(f"backfill added {added} candidate(s); now have {s['total']} total, {s['labeled']} labeled")

    lock = threading.Lock()
    app = build_app(conn, lock)
    print(f"open http://{args.host}:{args.port}/  —  press J / K / Space / Z")
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
