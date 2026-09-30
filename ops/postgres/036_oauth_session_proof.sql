-- Only a freshly authenticated OAuth session may add a new login method.
-- Old sessions have no proof and must sign in again before linking email.
CREATE TABLE IF NOT EXISTS account_oauth_session_proofs (
  token_hash text PRIMARY KEY REFERENCES account_sessions(token_hash) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('yandex', 'vk')),
  authenticated_at bigint NOT NULL
);
