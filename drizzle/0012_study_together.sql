-- Study Together: durable profiles, normalized availability, social requests,
-- room membership, session history, collaboration metadata, and safety reports.
-- Availability is stored twice on purpose: the user's authored windows remain
-- editable, while generated UTC slots make matching bounded and indexable.

CREATE TABLE IF NOT EXISTS sl_study_profiles (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  visibility TEXT NOT NULL DEFAULT 'discoverable',
  subjects_json TEXT NOT NULL DEFAULT '[]',
  topics_json TEXT NOT NULL DEFAULT '[]',
  goals_json TEXT NOT NULL DEFAULT '[]',
  learning_level TEXT NOT NULL DEFAULT 'all_levels',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  session_duration_minutes INTEGER NOT NULL DEFAULT 50,
  study_style TEXT NOT NULL DEFAULT 'quiet_focus',
  modes_json TEXT NOT NULL DEFAULT '["focus"]',
  languages_json TEXT NOT NULL DEFAULT '["English"]',
  interests_json TEXT NOT NULL DEFAULT '[]',
  cross_subject INTEGER NOT NULL DEFAULT 1,
  age_band TEXT NOT NULL DEFAULT 'any',
  current_goal TEXT NOT NULL DEFAULT '',
  reliability_score REAL NOT NULL DEFAULT 0,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_profiles_discoverable
  ON sl_study_profiles(status, visibility, updated_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_profiles_duration
  ON sl_study_profiles(status, session_duration_minutes);

CREATE TABLE IF NOT EXISTS sl_study_availability (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recurring',
  weekday INTEGER,
  date_key TEXT,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_availability_user
  ON sl_study_availability(user_id, kind, weekday, date_key);
CREATE INDEX IF NOT EXISTS idx_sl_study_availability_window
  ON sl_study_availability(weekday, start_minute, end_minute);

CREATE TABLE IF NOT EXISTS sl_study_availability_slots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  availability_id TEXT NOT NULL,
  slot_day TEXT NOT NULL,
  slot_start_utc TEXT NOT NULL,
  slot_end_utc TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_slots_start_end
  ON sl_study_availability_slots(slot_start_utc, slot_end_utc, user_id);
CREATE INDEX IF NOT EXISTS idx_sl_study_slots_user_day
  ON sl_study_availability_slots(user_id, slot_day);

CREATE TABLE IF NOT EXISTS sl_study_invitations (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  proposed_start_utc TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 50,
  mode TEXT NOT NULL DEFAULT 'focus',
  study_style TEXT NOT NULL DEFAULT 'quiet_focus',
  sender_subject TEXT NOT NULL DEFAULT '',
  recipient_subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  counter_start_utc TEXT,
  counter_duration_minutes INTEGER,
  counter_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_invitations_recipient_status
  ON sl_study_invitations(recipient_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_invitations_sender_status
  ON sl_study_invitations(sender_id, status, updated_at);

CREATE TABLE IF NOT EXISTS sl_study_rooms (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  subject TEXT NOT NULL DEFAULT '',
  max_participants INTEGER NOT NULL DEFAULT 4,
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 50,
  study_style TEXT NOT NULL DEFAULT 'quiet_focus',
  modes_json TEXT NOT NULL DEFAULT '["focus"]',
  pomodoro_json TEXT NOT NULL DEFAULT '{"focus":50,"break":10,"rounds":1}',
  rules_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_rooms_lobby
  ON sl_study_rooms(status, visibility, starts_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_rooms_host
  ON sl_study_rooms(host_id, updated_at);

CREATE TABLE IF NOT EXISTS sl_study_room_members (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_study_room_members_user
  ON sl_study_room_members(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_room_members_room
  ON sl_study_room_members(room_id, status);

CREATE TABLE IF NOT EXISTS sl_study_sessions (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  invitation_id TEXT,
  created_by TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  mode TEXT NOT NULL DEFAULT 'focus',
  study_style TEXT NOT NULL DEFAULT 'quiet_focus',
  goal_json TEXT NOT NULL DEFAULT '{}',
  pomodoro_json TEXT NOT NULL DEFAULT '{"focus":50,"break":10,"rounds":1}',
  video_room_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_sessions_user_time
  ON sl_study_sessions(status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_sessions_room
  ON sl_study_sessions(room_id, starts_at);

CREATE TABLE IF NOT EXISTS sl_study_session_members (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant',
  status TEXT NOT NULL DEFAULT 'scheduled',
  goal TEXT NOT NULL DEFAULT '',
  goal_completed INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT NOT NULL DEFAULT '',
  joined_at TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_study_session_members_user
  ON sl_study_session_members(user_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_sl_study_session_members_session
  ON sl_study_session_members(session_id, status);

CREATE TABLE IF NOT EXISTS sl_study_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_messages_session
  ON sl_study_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS sl_study_favorites (
  user_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, partner_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_study_favorites_partner
  ON sl_study_favorites(partner_id, created_at);

CREATE TABLE IF NOT EXISTS sl_study_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_user_id TEXT,
  room_id TEXT,
  session_id TEXT,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_study_reports_status
  ON sl_study_reports(status, created_at);
