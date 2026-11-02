-- Identity-owned service principals and API keys.
-- Context: identity
-- Idempotent: uses IF NOT EXISTS throughout.
-- No raw API-key secrets stored — only SHA-256 hash and public prefix.
-- Organization-bound; optional project scope carries explicit org_id + project_id.
-- No cross-context foreign keys to other bounded-context tables.

-- Service principals: org-bound automation actors.
CREATE TABLE IF NOT EXISTS identity.service_principals (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  project_id      UUID,
  display_name    TEXT        NOT NULL,
  description     TEXT,
  status          TEXT        NOT NULL DEFAULT 'active',
  created_by      UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT service_principals_status_check CHECK (status IN ('active', 'suspended', 'deleted')),
  CONSTRAINT service_principals_project_scope_check CHECK (
    project_id IS NULL OR org_id IS NOT NULL
  )
);

-- Org lookup: list service principals for an organization.
CREATE INDEX IF NOT EXISTS service_principals_org_id_idx
  ON identity.service_principals (org_id, created_at DESC);

-- Project-scoped lookup.
CREATE INDEX IF NOT EXISTS service_principals_org_project_idx
  ON identity.service_principals (org_id, project_id)
  WHERE project_id IS NOT NULL;

COMMENT ON TABLE identity.service_principals IS 'Organization-bound service principals — automation actors owned by identity context.';
COMMENT ON COLUMN identity.service_principals.org_id IS 'Owning organization. Opaque reference — no cross-context FK.';
COMMENT ON COLUMN identity.service_principals.project_id IS 'Optional project scope under the organization. Opaque reference — no cross-context FK.';
COMMENT ON COLUMN identity.service_principals.created_by IS 'User who created this service principal. Opaque reference — no FK enforced at schema level.';

-- API keys: belong to a service principal, org-scoped, secret-safe.
CREATE TABLE IF NOT EXISTS identity.api_keys (
  id                  UUID        PRIMARY KEY,
  service_principal_id UUID       NOT NULL REFERENCES identity.service_principals(id),
  org_id              UUID        NOT NULL,
  key_prefix          TEXT        NOT NULL,
  key_hash            TEXT        NOT NULL,
  label               TEXT        NOT NULL DEFAULT '',
  status              TEXT        NOT NULL DEFAULT 'active',
  expires_at          TIMESTAMPTZ,
  last_used_at        TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID,
  created_by          UUID        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT api_keys_prefix_length CHECK (char_length(key_prefix) >= 4 AND char_length(key_prefix) <= 12)
);

-- Unique hash index for auth-time lookup.
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx
  ON identity.api_keys (key_hash);

-- Org-scoped listing.
CREATE INDEX IF NOT EXISTS api_keys_org_id_idx
  ON identity.api_keys (org_id, created_at DESC);

-- Service principal listing.
CREATE INDEX IF NOT EXISTS api_keys_service_principal_idx
  ON identity.api_keys (service_principal_id, created_at DESC);

-- Prefix lookup for key identification (e.g., display in admin UI).
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx
  ON identity.api_keys (key_prefix);

COMMENT ON TABLE identity.api_keys IS 'API keys owned by identity context. Only hash and prefix stored — raw key material never persisted.';
COMMENT ON COLUMN identity.api_keys.key_prefix IS 'Public prefix of the API key (e.g., spk_abc1) for display and identification. 4-12 chars.';
COMMENT ON COLUMN identity.api_keys.key_hash IS 'SHA-256 hash of the full API key. Raw key never stored.';
COMMENT ON COLUMN identity.api_keys.org_id IS 'Owning organization. Denormalized from service principal for efficient org-scoped queries. Opaque — no cross-context FK.';
COMMENT ON COLUMN identity.api_keys.revoked_by IS 'User who revoked this key. Opaque reference.';
