ALTER TABLE chatgpt_auth_state ADD COLUMN email TEXT;
ALTER TABLE chatgpt_auth_state ADD COLUMN label TEXT;
ALTER TABLE chatgpt_auth_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chatgpt_auth_state ADD COLUMN last_selected_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chatgpt_auth_state ADD COLUMN selection_count INTEGER NOT NULL DEFAULT 0;

-- The original schema used the literal `default` for its only row. Account ids are
-- stable and make suitable pool row ids, so preserve that account while migrating it.
UPDATE chatgpt_auth_state SET id = account_id WHERE id = 'default';

CREATE UNIQUE INDEX IF NOT EXISTS chatgpt_auth_state_account_id
  ON chatgpt_auth_state(account_id);
CREATE INDEX IF NOT EXISTS chatgpt_auth_state_rotation
  ON chatgpt_auth_state(enabled, last_selected_at, selection_count);

CREATE TABLE IF NOT EXISTS chatgpt_auth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  request_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS chatgpt_auth_clients_token_hash
  ON chatgpt_auth_clients(token_hash);

CREATE TABLE IF NOT EXISTS chatgpt_auth_token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  account_id TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS chatgpt_auth_token_events_occurred_at
  ON chatgpt_auth_token_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS chatgpt_auth_token_events_client
  ON chatgpt_auth_token_events(client_id, occurred_at DESC);
