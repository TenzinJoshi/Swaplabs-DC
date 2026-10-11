CREATE TABLE IF NOT EXISTS sl_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  allow_external_access INTEGER NOT NULL DEFAULT 1,
  blocked_categories_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_organizations_owner_unique
  ON sl_organizations(owner_id);

CREATE INDEX IF NOT EXISTS idx_sl_organizations_created
  ON sl_organizations(created_at);

CREATE TABLE IF NOT EXISTS sl_organization_members (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_sl_organization_members_user_role
  ON sl_organization_members(user_id, role);

CREATE TABLE IF NOT EXISTS sl_organization_activity (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_organization_activity_org_created
  ON sl_organization_activity(organization_id, created_at);
