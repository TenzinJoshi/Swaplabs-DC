CREATE TABLE IF NOT EXISTS sl_direct_conversations (
  pair_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sl_direct_conversations_id
  ON sl_direct_conversations(conversation_id);
