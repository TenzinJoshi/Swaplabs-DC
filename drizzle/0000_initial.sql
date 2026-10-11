CREATE TABLE IF NOT EXISTS sl_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  verified INTEGER NOT NULL DEFAULT 0,
  time_credits INTEGER NOT NULL DEFAULT 30,
  reward_points INTEGER NOT NULL DEFAULT 0,
  profile_json TEXT NOT NULL,
  preferences_json TEXT NOT NULL,
  safety_json TEXT NOT NULL,
  moderation_label TEXT NOT NULL DEFAULT 'none',
  admin_notes TEXT NOT NULL DEFAULT '',
  messaging_restricted INTEGER NOT NULL DEFAULT 0,
  suspended_until TEXT,
  suspension_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  terms_accepted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_users_username_unique
  ON sl_users(username COLLATE NOCASE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_users_email_unique
  ON sl_users(email COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_sl_users_status
  ON sl_users(status);

CREATE INDEX IF NOT EXISTS idx_sl_users_created_at
  ON sl_users(created_at);

CREATE TABLE IF NOT EXISTS sl_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_sessions_user_id
  ON sl_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sl_sessions_expires_at
  ON sl_sessions(expires_at);

CREATE TABLE IF NOT EXISTS sl_audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  target_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_audit_log_created_at
  ON sl_audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_sl_audit_log_target_id
  ON sl_audit_log(target_id);
