CREATE TABLE IF NOT EXISTS sl_courses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  level TEXT NOT NULL DEFAULT 'All levels',
  estimated_hours REAL NOT NULL DEFAULT 1,
  resource_url TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'draft',
  lessons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sl_courses_public_created
  ON sl_courses(visibility, status, published_at);

CREATE INDEX IF NOT EXISTS idx_sl_courses_owner_created
  ON sl_courses(owner_id, created_at);
