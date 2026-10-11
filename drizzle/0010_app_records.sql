CREATE TABLE IF NOT EXISTS sl_app_records (
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, record_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_app_records_collection_updated
  ON sl_app_records(collection, updated_at);

CREATE INDEX IF NOT EXISTS idx_sl_app_records_owner_updated
  ON sl_app_records(owner_id, updated_at);
