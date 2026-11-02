ALTER TABLE llm_auth_state ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'xai'));
ALTER TABLE llm_auth_state ADD COLUMN oauth_client_id TEXT;
ALTER TABLE llm_auth_state ADD COLUMN client_version TEXT;
CREATE INDEX llm_auth_state_provider_rotation ON llm_auth_state(provider, enabled, last_selected_at, selection_count);
ALTER TABLE llm_auth_login_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'openai';
