-- Additive only: this migration never resets an existing balance.
CREATE TABLE IF NOT EXISTS sl_app_records (collection TEXT NOT NULL, record_id TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT '', record_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, record_id));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sl_monthly_credit_grants (
  user_id TEXT NOT NULL REFERENCES sl_users(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (length(period) = 7 AND period >= '2026-11'),
  amount INTEGER NOT NULL CHECK (amount = 15),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, period)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sl_monthly_credit_grants_period ON sl_monthly_credit_grants(period);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sl_monthly_credit_runs (
  period TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL
);
--> statement-breakpoint
-- An insert, its balance increment and its ledger entry are one transaction.
-- A retry cannot insert the same (user, month) twice. Ledger failures roll back
-- the increment too, rather than silently granting untraceable credits.
CREATE TRIGGER IF NOT EXISTS sl_monthly_credit_grant_apply
AFTER INSERT ON sl_monthly_credit_grants
BEGIN
  UPDATE sl_users SET time_credits = time_credits + NEW.amount,
    updated_at = NEW.created_at WHERE id = NEW.user_id;
  INSERT INTO sl_app_records (collection, record_id, owner_id, record_json, created_at, updated_at)
  SELECT 'ledger', 'monthly-credit:' || NEW.period || ':' || NEW.user_id, NEW.user_id,
    json_object(
      'id', 'monthly-credit:' || NEW.period || ':' || NEW.user_id,
      'user_id', NEW.user_id, 'type', 'monthly_allowance', 'amount', NEW.amount,
      'balance_after', time_credits,
      'description', 'Monthly credit allowance · ' || NEW.period,
      'reference_id', 'monthly-credit:' || NEW.period || ':' || NEW.user_id,
      'reference_type', 'monthly_allowance', 'created_by', 'system',
      'period', NEW.period, 'created_at', NEW.created_at, 'updated_at', NEW.created_at
    ), NEW.created_at, NEW.created_at
  FROM sl_users WHERE id = NEW.user_id;
END;
