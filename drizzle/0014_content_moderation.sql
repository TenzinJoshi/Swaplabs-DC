CREATE TABLE IF NOT EXISTS sl_blocked_words (
  id TEXT PRIMARY KEY,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_blocked_words_normalized_unique
  ON sl_blocked_words(normalized_phrase);

CREATE INDEX IF NOT EXISTS idx_sl_blocked_words_enabled
  ON sl_blocked_words(enabled, created_at);

CREATE TABLE IF NOT EXISTS sl_moderation_items (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  content_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_json TEXT NOT NULL,
  file_context_json TEXT NOT NULL DEFAULT '[]',
  submitter_json TEXT NOT NULL DEFAULT '{}',
  triggered_rule_id TEXT,
  triggered_rule TEXT NOT NULL,
  triggered_rules_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'deleted')),
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_lock_at TEXT,
  replay_secret_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sl_moderation_items_status_submitted
  ON sl_moderation_items(status, submitted_at);

CREATE INDEX IF NOT EXISTS idx_sl_moderation_items_user_submitted
  ON sl_moderation_items(user_id, submitted_at);

-- Binary uploads are split into bounded private chunks so moderation does not
-- require an R2/public-media binding and pending uploads stay inaccessible.
CREATE TABLE IF NOT EXISTS sl_moderation_files (
  item_id TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_data BLOB NOT NULL,
  PRIMARY KEY (item_id, file_index, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_sl_moderation_files_item
  ON sl_moderation_files(item_id, file_index, chunk_index);

CREATE TABLE IF NOT EXISTS sl_moderation_audit (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  user_id TEXT,
  triggered_rule TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL CHECK (new_status IN ('pending', 'approved', 'deleted')),
  admin_id TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_moderation_audit_content_created
  ON sl_moderation_audit(content_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sl_moderation_audit_created
  ON sl_moderation_audit(created_at);
