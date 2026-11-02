ALTER TABLE llm_auth_clients ADD COLUMN account_ids TEXT;
ALTER TABLE llm_auth_clients ADD COLUMN deleted_at INTEGER;

CREATE TABLE llm_auth_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_key_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'ticket')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX llm_auth_admin_sessions_expiry ON llm_auth_admin_sessions(expires_at);

CREATE TABLE llm_auth_login_attempts (
  id TEXT PRIMARY KEY,
  device_auth_id TEXT,
  user_code TEXT,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  account_id TEXT,
  interval_ms INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  lock_until INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE llm_auth_login_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);
