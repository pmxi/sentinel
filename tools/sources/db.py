"""Postgres store for the Mediacloud source catalog (schema `sources`)."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

SCHEMA_PATH = Path(__file__).parent / "schema.sql"
DATABASE_URL_ENV = "DATABASE_URL"


def open_db(database_url: str | None = None) -> psycopg.Connection:
    url = database_url or os.environ.get(DATABASE_URL_ENV)
    if not url:
        raise RuntimeError(
            f"set {DATABASE_URL_ENV} to the sentinel postgres connection string"
        )
    conn = psycopg.connect(url, row_factory=dict_row)
    conn.autocommit = True
    conn.execute(SCHEMA_PATH.read_text())
    conn.execute("SET search_path TO sources, public")
    return conn
