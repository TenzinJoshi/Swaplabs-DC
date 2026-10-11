CREATE TABLE IF NOT EXISTS sl_user_presence_days (
  user_id TEXT NOT NULL REFERENCES sl_users(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  page_path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day_key)
);

CREATE INDEX IF NOT EXISTS idx_sl_user_presence_days_last_seen
  ON sl_user_presence_days(last_seen_at);
