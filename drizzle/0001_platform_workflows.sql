CREATE TABLE IF NOT EXISTS sl_workshops (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  level TEXT NOT NULL,
  format TEXT NOT NULL,
  location TEXT NOT NULL,
  timezone TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  seat_limit INTEGER NOT NULL,
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'scheduled',
  admin_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_workshops_status_starts
  ON sl_workshops(status, starts_at);

CREATE TABLE IF NOT EXISTS sl_workshop_registrations (
  id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'registered',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_workshop_registration_unique
  ON sl_workshop_registrations(workshop_id, user_id);

CREATE INDEX IF NOT EXISTS idx_sl_workshop_registration_workshop_status
  ON sl_workshop_registrations(workshop_id, status);

CREATE TABLE IF NOT EXISTS sl_conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'direct',
  title TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_conversations_updated
  ON sl_conversations(updated_at);

CREATE TABLE IF NOT EXISTS sl_conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  muted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_conversation_members_user_hidden
  ON sl_conversation_members(user_id, hidden);

CREATE TABLE IF NOT EXISTS sl_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  moderation_status TEXT NOT NULL DEFAULT 'visible',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_messages_conversation_created
  ON sl_messages(conversation_id, created_at);
