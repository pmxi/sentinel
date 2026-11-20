CREATE TABLE sent_live_changes (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('full','message','thread','metadata')),
  message_id TEXT,
  thread_id TEXT
);
