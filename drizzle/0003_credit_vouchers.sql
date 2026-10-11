CREATE TABLE IF NOT EXISTS sl_credit_vouchers (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'active',
  redeemer_id TEXT,
  created_at TEXT NOT NULL,
  redeemed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_credit_vouchers_code_hash_unique
  ON sl_credit_vouchers(code_hash);

CREATE INDEX IF NOT EXISTS idx_sl_credit_vouchers_creator_status_created
  ON sl_credit_vouchers(creator_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_sl_credit_vouchers_status
  ON sl_credit_vouchers(status);
