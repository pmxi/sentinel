CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$ BEGIN
  CREATE TYPE provider AS ENUM ('gmail', 'microsoft');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('active', 'needs_reauth', 'syncing', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE mutation_status AS ENUM ('pending', 'processing', 'complete', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider provider NOT NULL, email text NOT NULL,
  display_name text NOT NULL DEFAULT '', encrypted_credentials text NOT NULL,
  status account_status NOT NULL DEFAULT 'active', last_synced_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, email)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, cursor text,
  backfill_complete boolean NOT NULL DEFAULT false, last_successful_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_thread_id text NOT NULL, subject text NOT NULL DEFAULT '', last_message_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_thread_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE, provider_message_id text NOT NULL,
  internet_message_id text, subject text NOT NULL DEFAULT '', from_addresses jsonb NOT NULL DEFAULT '[]',
  to_addresses jsonb NOT NULL DEFAULT '[]', cc_addresses jsonb NOT NULL DEFAULT '[]',
  bcc_addresses jsonb NOT NULL DEFAULT '[]', sent_at timestamptz, received_at timestamptz NOT NULL,
  snippet text NOT NULL DEFAULT '', text_body text NOT NULL DEFAULT '', html_body text, headers jsonb NOT NULL DEFAULT '{}',
  attachments jsonb NOT NULL DEFAULT '[]', direction message_direction NOT NULL, read boolean NOT NULL DEFAULT false,
  flagged boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false, deleted boolean NOT NULL DEFAULT false,
  tombstone boolean NOT NULL DEFAULT false, native_state jsonb NOT NULL DEFAULT '{}', provider_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(from_addresses::text, '') || ' ' || coalesce(to_addresses::text, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(text_body, '')), 'B')
  ) STORED,
  UNIQUE (account_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS messages_received_idx ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING gin(search_document);
CREATE TABLE IF NOT EXISTS provider_containers (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider_id text NOT NULL,
  name text NOT NULL, kind text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(account_id, provider_id)
);
CREATE TABLE IF NOT EXISTS message_containers (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider_id text NOT NULL,
  PRIMARY KEY(message_id, provider_id)
);
CREATE TABLE IF NOT EXISTS classifications (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model_tier integer NOT NULL CHECK (model_tier BETWEEN 1 AND 3), reasoning text NOT NULL,
  manual_tier integer CHECK (manual_tier BETWEEN 1 AND 3), model text NOT NULL, prompt_version text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS classification_failures (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 1, last_error text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS embeddings (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding vector(3072) NOT NULL, model text NOT NULL, content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_addresses jsonb NOT NULL DEFAULT '[]', cc_addresses jsonb NOT NULL DEFAULT '[]', bcc_addresses jsonb NOT NULL DEFAULT '[]',
  subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  forward_of_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mutation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key text NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE, action text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  status mutation_status NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mutation_outbox_pending_idx ON mutation_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS worker_state (
  name text PRIMARY KEY, heartbeat_at timestamptz NOT NULL DEFAULT now(), metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sent_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
);
