ALTER TABLE chatgpt_auth_admin_sessions ADD COLUMN email TEXT;
ALTER TABLE chatgpt_auth_admin_sessions ADD COLUMN google_audience TEXT;

CREATE TABLE chatgpt_auth_google_logins (
  token_hash TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
