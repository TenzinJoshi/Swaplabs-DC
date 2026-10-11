CREATE TABLE IF NOT EXISTS sl_community_posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  media_key TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT '',
  media_content_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_community_posts_created
  ON sl_community_posts(created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_posts_author_created
  ON sl_community_posts(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_posts_status_created
  ON sl_community_posts(status, created_at);

CREATE TABLE IF NOT EXISTS sl_community_post_likes (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_community_post_likes_unique
  ON sl_community_post_likes(post_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_likes_post
  ON sl_community_post_likes(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_likes_user
  ON sl_community_post_likes(user_id, created_at);

CREATE TABLE IF NOT EXISTS sl_community_post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_community_post_comments_post_created
  ON sl_community_post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_comments_author_created
  ON sl_community_post_comments(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_comments_status
  ON sl_community_post_comments(status);

CREATE TABLE IF NOT EXISTS sl_community_post_shares (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_community_post_shares_unique
  ON sl_community_post_shares(post_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_shares_post
  ON sl_community_post_shares(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_post_shares_user
  ON sl_community_post_shares(user_id, created_at);

CREATE TABLE IF NOT EXISTS sl_community_stories (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  media_key TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT '',
  media_content_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sl_community_stories_expires
  ON sl_community_stories(expires_at, status);
CREATE INDEX IF NOT EXISTS idx_sl_community_stories_author_created
  ON sl_community_stories(author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sl_community_stories_status_created
  ON sl_community_stories(status, created_at);
