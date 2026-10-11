CREATE TABLE IF NOT EXISTS sl_blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_blocks_blocked
  ON sl_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS sl_message_visibility (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_message_visibility_user_hidden
  ON sl_message_visibility(user_id, hidden);
