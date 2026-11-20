CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('gmail','microsoft')), email text NOT NULL,
  display_name text NOT NULL DEFAULT '', encrypted_credentials text NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_reauth','syncing','error')) DEFAULT 'active', last_synced_at TEXT, last_error text,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')),
  UNIQUE (provider, email)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, cursor text,
  backfill_complete INTEGER NOT NULL DEFAULT false, last_successful_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_thread_id text NOT NULL, subject text NOT NULL DEFAULT '', last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')),
  UNIQUE (account_id, provider_thread_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, provider_message_id text NOT NULL,
  internet_message_id text, subject text NOT NULL DEFAULT '', from_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(from_addresses)),
  to_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(to_addresses)), cc_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(cc_addresses)),
  bcc_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bcc_addresses)), sent_at TEXT, received_at TEXT NOT NULL,
  snippet text NOT NULL DEFAULT '', text_body text NOT NULL DEFAULT '', html_body text, headers TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(headers)),
  attachments TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments)), direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')), read INTEGER NOT NULL DEFAULT false,
  flagged INTEGER NOT NULL DEFAULT false, archived INTEGER NOT NULL DEFAULT false, deleted INTEGER NOT NULL DEFAULT false,
  tombstone INTEGER NOT NULL DEFAULT false, native_state TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(native_state)), provider_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')),
  UNIQUE (account_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS messages_received_idx ON messages(received_at DESC);
CREATE VIRTUAL TABLE messages_search USING fts5(subject, addresses, text_body, tokenize='porter unicode61');
CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_search(rowid,subject,addresses,text_body) VALUES(new.rowid,new.subject,new.from_addresses || ' ' || new.to_addresses,new.text_body);
END;
CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_search WHERE rowid=old.rowid;
END;
CREATE TRIGGER messages_search_update AFTER UPDATE OF subject,from_addresses,to_addresses,text_body ON messages BEGIN
  DELETE FROM messages_search WHERE rowid=old.rowid;
  INSERT INTO messages_search(rowid,subject,addresses,text_body) VALUES(new.rowid,new.subject,new.from_addresses || ' ' || new.to_addresses,new.text_body);
END;
CREATE TABLE IF NOT EXISTS provider_containers (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider_id text NOT NULL,
  name text NOT NULL, kind text NOT NULL, metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata)), PRIMARY KEY(account_id, provider_id)
);
CREATE TABLE IF NOT EXISTS message_containers (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, provider_id text NOT NULL,
  PRIMARY KEY(message_id, provider_id)
);
CREATE TABLE IF NOT EXISTS classifications (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  model_tier integer NOT NULL CHECK (model_tier BETWEEN 1 AND 3), reasoning text NOT NULL,
  plain_text text, summary text,
  manual_tier integer CHECK (manual_tier BETWEEN 1 AND 3), model text NOT NULL, prompt_version text NOT NULL,
  classified_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);
CREATE TABLE IF NOT EXISTS classification_failures (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 1, last_error text NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);
CREATE TABLE IF NOT EXISTS embeddings (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  embedding BLOB CHECK(typeof(embedding)='blob' AND length(embedding)=12288) NOT NULL, model text NOT NULL, content_hash text NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(to_addresses)), cc_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(cc_addresses)), bcc_addresses TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(bcc_addresses)),
  subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  forward_of_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);
CREATE TABLE IF NOT EXISTS mutation_outbox (
  id TEXT PRIMARY KEY NOT NULL, idempotency_key text NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE, action text NOT NULL, payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','complete','failed')) DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), last_error text,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), completed_at TEXT
);
CREATE INDEX IF NOT EXISTS mutation_outbox_pending_idx ON mutation_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS worker_state (
  name text PRIMARY KEY NOT NULL, heartbeat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now')), metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata))
);

CREATE TABLE IF NOT EXISTS sent_migrations (
  filename text PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f000Z','now'))
);

CREATE TABLE sent_body_revisions (
  message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision TEXT NOT NULL
);
CREATE TRIGGER messages_revision_insert AFTER INSERT ON messages BEGIN
  INSERT INTO sent_body_revisions VALUES(new.id,lower(hex(randomblob(16))));
END;
CREATE TRIGGER messages_revision_update AFTER UPDATE ON messages BEGIN
  UPDATE sent_body_revisions SET revision=lower(hex(randomblob(16))) WHERE message_id=new.id;
END;
CREATE TRIGGER classifications_revision_insert AFTER INSERT ON classifications BEGIN
  UPDATE sent_body_revisions SET revision=lower(hex(randomblob(16))) WHERE message_id=new.message_id;
END;
CREATE TRIGGER classifications_revision_update AFTER UPDATE ON classifications BEGIN
  UPDATE sent_body_revisions SET revision=lower(hex(randomblob(16))) WHERE message_id=new.message_id;
END;
CREATE TRIGGER classifications_revision_delete AFTER DELETE ON classifications BEGIN
  UPDATE sent_body_revisions SET revision=lower(hex(randomblob(16))) WHERE message_id=old.message_id;
END;
