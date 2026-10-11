CREATE TABLE IF NOT EXISTS sl_user_presence (
  user_id TEXT PRIMARY KEY REFERENCES sl_users(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_user_presence_last_seen
  ON sl_user_presence(last_seen_at);
