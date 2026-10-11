CREATE TABLE IF NOT EXISTS sl_community_groups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Community',
  icon TEXT NOT NULL DEFAULT 'bx-group',
  accent TEXT NOT NULL DEFAULT 'blue',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_community_groups_created
  ON sl_community_groups(created_at);

CREATE TABLE IF NOT EXISTS sl_community_group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_community_group_members_user_status
  ON sl_community_group_members(user_id, status);

CREATE TABLE IF NOT EXISTS sl_community_group_join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_community_group_join_requests_unique
  ON sl_community_group_join_requests(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sl_community_group_join_requests_group_status
  ON sl_community_group_join_requests(group_id, status);

CREATE TABLE IF NOT EXISTS sl_livestreams (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Community',
  tags_json TEXT NOT NULL DEFAULT '[]',
  scheduled_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  duration_minutes INTEGER NOT NULL DEFAULT 120,
  credits_donated INTEGER NOT NULL DEFAULT 0,
  reward_credits_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_livestreams_status_schedule
  ON sl_livestreams(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_sl_livestreams_host_created
  ON sl_livestreams(host_id, created_at);

CREATE TABLE IF NOT EXISTS sl_livestream_members (
  stream_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (stream_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_livestream_members_stream_active
  ON sl_livestream_members(stream_id, left_at, last_seen_at);

CREATE TABLE IF NOT EXISTS sl_livestream_chat (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  donation_credits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_livestream_chat_stream_created
  ON sl_livestream_chat(stream_id, created_at);

CREATE TABLE IF NOT EXISTS sl_livestream_signals (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_livestream_signals_stream_created
  ON sl_livestream_signals(stream_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_livestream_signals_target_created
  ON sl_livestream_signals(stream_id, to_id, created_at);
