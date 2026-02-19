CREATE TABLE IF NOT EXISTS chatgpt_auth_state (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  id_token TEXT,
  expires_at INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  lock_until INTEGER
);

