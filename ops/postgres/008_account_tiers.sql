-- Account tier is independent of per-archive roles and ownership.
CREATE TABLE IF NOT EXISTS account_tiers (
  account_id text PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  full_access boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now()
);
