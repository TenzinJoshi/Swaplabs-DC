CREATE TABLE IF NOT EXISTS sl_workshop_shares (
  share_id TEXT PRIMARY KEY,
  workshop_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_workshop_shares_workshop_unique
  ON sl_workshop_shares(workshop_id);

CREATE INDEX IF NOT EXISTS idx_sl_workshop_shares_expiry
  ON sl_workshop_shares(expires_at);
