CREATE TABLE IF NOT EXISTS sl_follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL,
  following_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_follows_pair_unique
  ON sl_follows(follower_id, following_id);

CREATE INDEX IF NOT EXISTS idx_sl_follows_following_status
  ON sl_follows(following_id, status);

CREATE INDEX IF NOT EXISTS idx_sl_follows_follower_status
  ON sl_follows(follower_id, status);

CREATE TABLE IF NOT EXISTS sl_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  actor_id TEXT,
  type TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_notifications_user_read_created
  ON sl_notifications(user_id, read, created_at);
