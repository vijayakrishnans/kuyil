-- Identity persistence foundation.
-- Context: identity
-- Idempotent: uses IF NOT EXISTS throughout.

CREATE SCHEMA IF NOT EXISTS identity;

COMMENT ON SCHEMA identity IS 'Identity bounded context — owns users, auth identities, login challenges, and sessions.';

-- Users: the root identity record.
CREATE TABLE IF NOT EXISTS identity.users (
  id            UUID        PRIMARY KEY,
  email         TEXT        NOT NULL,
  email_lower   TEXT        NOT NULL,
  display_name  TEXT,
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON identity.users (email_lower);

COMMENT ON TABLE identity.users IS 'Root user records owned by the identity context.';
COMMENT ON COLUMN identity.users.email_lower IS 'Normalized (lower-case) email for case-insensitive uniqueness.';

-- Auth identities: links a user to an external or internal auth provider.
CREATE TABLE IF NOT EXISTS identity.auth_identities (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES identity.users(id),
  provider    TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_provider_subject_idx
  ON identity.auth_identities (provider, subject);

CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx
  ON identity.auth_identities (user_id);

COMMENT ON TABLE identity.auth_identities IS 'Links users to auth providers (email, OAuth, etc).';
COMMENT ON COLUMN identity.auth_identities.subject IS 'Provider-scoped subject identifier (e.g. email address, OAuth sub).';

-- Login challenges: short-lived passwordless login proofs.
CREATE TABLE IF NOT EXISTS identity.login_challenges (
  id              UUID        PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES identity.users(id),
  method          TEXT        NOT NULL,
  code_hash       TEXT        NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT login_challenges_method_check CHECK (method IN ('email_code', 'magic_link'))
);

CREATE INDEX IF NOT EXISTS login_challenges_user_id_idx
  ON identity.login_challenges (user_id);

COMMENT ON TABLE identity.login_challenges IS 'Short-lived passwordless login proofs. Only hashes stored.';
COMMENT ON COLUMN identity.login_challenges.code_hash IS 'SHA-256 hash of the one-time code or magic-link token. Raw value never stored.';

-- Sessions: active bearer session tokens.
CREATE TABLE IF NOT EXISTS identity.sessions (
  id            UUID        PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES identity.users(id),
  token_hash    TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx
  ON identity.sessions (token_hash);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx
  ON identity.sessions (user_id);

COMMENT ON TABLE identity.sessions IS 'Active user sessions. Only token hashes stored.';
COMMENT ON COLUMN identity.sessions.token_hash IS 'SHA-256 hash of the bearer token. Raw token never stored.';
