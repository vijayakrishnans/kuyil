-- 070_config_settings_flags
-- Config persistence foundation — settings, feature flags, and secret metadata
-- Bounded context: config
-- Idempotent: uses IF NOT EXISTS throughout.
-- No plaintext secret values stored — only key metadata and ciphertext envelope placeholders.
-- Scoped at organization, project, and environment levels with explicit scope columns.
-- No cross-context foreign keys to membership or projects schemas.

CREATE SCHEMA IF NOT EXISTS config;

COMMENT ON SCHEMA config IS 'Config bounded context — owns settings, feature flags, and secret metadata persistence.';

-- ============================================================
-- Settings: scoped non-secret JSON configuration values.
-- scope_kind determines which scope columns are populated.
-- ============================================================

CREATE TABLE IF NOT EXISTS config.settings (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  project_id      UUID,
  environment_id  UUID,
  scope_kind      TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  value           JSONB       NOT NULL DEFAULT '{}',
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settings_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),

  -- Organization scope: only org_id set
  CONSTRAINT settings_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  -- Project scope: org_id + project_id set, no environment_id
  CONSTRAINT settings_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  -- Environment scope: all three IDs set
  CONSTRAINT settings_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- Unique key per scope tuple
CREATE UNIQUE INDEX IF NOT EXISTS settings_scope_key_idx
  ON config.settings (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), key);

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_created_idx
  ON config.settings (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_project_created_idx
  ON config.settings (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS settings_org_project_env_created_idx
  ON config.settings (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

COMMENT ON TABLE config.settings IS 'Scoped non-secret settings. Every query must scope by org_id.';
COMMENT ON COLUMN config.settings.org_id IS 'Owning organization — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.settings.project_id IS 'Optional project scope — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.settings.environment_id IS 'Optional environment scope — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.settings.scope_kind IS 'Discriminator: organization, project, or environment.';
COMMENT ON COLUMN config.settings.key IS 'Setting key within the scope.';
COMMENT ON COLUMN config.settings.value IS 'Non-secret JSONB payload.';

-- ============================================================
-- Feature flags: scoped flag definitions with default state.
-- ============================================================

CREATE TABLE IF NOT EXISTS config.feature_flags (
  id              UUID        PRIMARY KEY,
  org_id          UUID        NOT NULL,
  project_id      UUID,
  environment_id  UUID,
  scope_kind      TEXT        NOT NULL,
  flag_key        TEXT        NOT NULL,
  enabled         BOOLEAN     NOT NULL DEFAULT false,
  value           JSONB,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT feature_flags_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),

  CONSTRAINT feature_flags_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  CONSTRAINT feature_flags_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  CONSTRAINT feature_flags_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);

-- Unique flag key per scope tuple
CREATE UNIQUE INDEX IF NOT EXISTS feature_flags_scope_key_idx
  ON config.feature_flags (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), flag_key);

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_created_idx
  ON config.feature_flags (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_project_created_idx
  ON config.feature_flags (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS feature_flags_org_project_env_created_idx
  ON config.feature_flags (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

COMMENT ON TABLE config.feature_flags IS 'Scoped feature flag definitions. Every query must scope by org_id.';
COMMENT ON COLUMN config.feature_flags.flag_key IS 'Unique flag key within the scope.';
COMMENT ON COLUMN config.feature_flags.enabled IS 'Default enabled/disabled state.';
COMMENT ON COLUMN config.feature_flags.value IS 'Optional JSONB payload for flag variants or metadata.';

-- ============================================================
-- Secret metadata: key metadata, status, version/rotation info.
-- NEVER stores plaintext secret values.
-- An optional ciphertext_envelope column holds encrypted data.
-- ============================================================

CREATE TABLE IF NOT EXISTS config.secret_metadata (
  id                  UUID        PRIMARY KEY,
  org_id              UUID        NOT NULL,
  project_id          UUID,
  environment_id      UUID,
  scope_kind          TEXT        NOT NULL,
  secret_key          TEXT        NOT NULL,
  display_name        TEXT,
  status              TEXT        NOT NULL DEFAULT 'active',
  version             INTEGER     NOT NULL DEFAULT 1,
  ciphertext_envelope BYTEA,
  rotation_policy     TEXT,
  last_rotated_at     TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_by          UUID        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT secret_metadata_scope_kind_check CHECK (scope_kind IN ('organization', 'project', 'environment')),
  CONSTRAINT secret_metadata_status_check CHECK (status IN ('active', 'rotated', 'revoked')),

  CONSTRAINT secret_metadata_org_scope_check CHECK (
    scope_kind <> 'organization' OR (project_id IS NULL AND environment_id IS NULL)
  ),
  CONSTRAINT secret_metadata_project_scope_check CHECK (
    scope_kind <> 'project' OR (project_id IS NOT NULL AND environment_id IS NULL)
  ),
  CONSTRAINT secret_metadata_env_scope_check CHECK (
    scope_kind <> 'environment' OR (project_id IS NOT NULL AND environment_id IS NOT NULL)
  ),
  CONSTRAINT secret_metadata_version_positive CHECK (version >= 1)
);

-- Unique secret key per scope tuple (only active/rotated — revoked are historical)
CREATE UNIQUE INDEX IF NOT EXISTS secret_metadata_scope_key_idx
  ON config.secret_metadata (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), secret_key)
  WHERE status IN ('active', 'rotated');

-- Org-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_created_idx
  ON config.secret_metadata (org_id, created_at DESC, id DESC);

-- Project-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_project_created_idx
  ON config.secret_metadata (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- Environment-scoped listing
CREATE INDEX IF NOT EXISTS secret_metadata_org_project_env_created_idx
  ON config.secret_metadata (org_id, project_id, environment_id, created_at DESC, id DESC)
  WHERE environment_id IS NOT NULL;

COMMENT ON TABLE config.secret_metadata IS 'Secret metadata records. NEVER contains plaintext secret values. Ciphertext envelope is encrypted data only.';
COMMENT ON COLUMN config.secret_metadata.org_id IS 'Owning organization — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.project_id IS 'Optional project scope — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.environment_id IS 'Optional environment scope — opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_metadata.secret_key IS 'Identifier for this secret within its scope.';
COMMENT ON COLUMN config.secret_metadata.ciphertext_envelope IS 'Encrypted secret payload — NEVER plaintext. Null until an encryption adapter writes it.';
COMMENT ON COLUMN config.secret_metadata.version IS 'Monotonically increasing version number for rotation tracking.';
COMMENT ON COLUMN config.secret_metadata.created_by IS 'User or service principal who created/rotated this secret — opaque reference.';
