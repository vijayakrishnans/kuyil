-- 180_integrations_foundation: Integrations persistence foundation (IG0).
--
-- Context: integrations
-- Epic: saas-integrations (IG0) — the dormant contract-and-schema slice for
--       the pluggable integrations platform (GitHub App first). No live
--       behavior rides on this migration; it lands the bounded context's
--       tables so IG1+ (connect flow, inbound events, repo links, token
--       broker) are schema-complete from day one.
--
-- Design rules (see specs/epics/saas-integrations/design.md §3):
--   * Every tenant-owned table carries org_id UUID NOT NULL; the one
--     exception is inbound_deliveries, whose org_id stays NULL until the
--     cron drain attributes the delivery (installation → connection → org).
--   * Keyset pagination indexes (org_id, created_at DESC, id DESC).
--   * Platform credentials (App private key, webhook secret, client
--     id/secret) are NOT rows — they are per-environment worker secrets.
--   * Cached installation tokens are AES-256-GCM envelopes, write-only;
--     never logged, never returned by list/read APIs.
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS integrations;

-- ── Connections ────────────────────────────────────────────
-- Provider-agnostic org ↔ provider connection (a GitHub App installation
-- bound to an organization). The signed-state nonce for the in-flight
-- connect flow is persisted (hashed) on the pending row and cleared on
-- activation — the tenancy keystone (design §4) is carried by our state,
-- never inferred from the provider redirect.

CREATE TABLE IF NOT EXISTS integrations.connections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL,
  provider                TEXT NOT NULL,          -- registry-driven: 'github' first
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  display_name            TEXT,
  external_account_login  TEXT,
  external_account_id     TEXT,
  external_account_type   TEXT,                   -- GitHub: 'Organization' | 'User'
  created_by              TEXT,                   -- actor public id

  -- Connect-flow state (write-only; hash of the single-use signed nonce)
  state_nonce_hash        TEXT,
  state_expires_at        TIMESTAMPTZ,

  connected_at            TIMESTAMPTZ,
  suspended_at            TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_connections_org
  ON integrations.connections (org_id, created_at DESC, id DESC);

-- One ACTIVE connection per (org, provider, provider account)
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_connection_active_account
  ON integrations.connections (org_id, provider, external_account_id)
  WHERE status = 'active' AND external_account_id IS NOT NULL;

-- Connect-flow nonce lookup (sparse: only pending rows carry a nonce)
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_connection_state_nonce
  ON integrations.connections (state_nonce_hash)
  WHERE state_nonce_hash IS NOT NULL;

-- ── GitHub installations ───────────────────────────────────
-- Provider-specific facts behind a connection. connection_id is NULL for
-- orphaned installations (unsolicited installs with no valid state) — they
-- are recorded, admin-visible, and never auto-bound to a tenant (fail
-- closed, design §4).

CREATE TABLE IF NOT EXISTS integrations.github_installations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id         UUID,                     -- NULL = orphaned installation
  installation_id       BIGINT NOT NULL,          -- GitHub installation id
  account_login         TEXT,
  account_id            BIGINT,
  account_type          TEXT,                     -- 'Organization' | 'User'
  repository_selection  TEXT,                     -- 'all' | 'selected'
  permissions           JSONB,                    -- App grant snapshot
  events                JSONB,                    -- subscribed webhook events
  suspended_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_github_installation
  ON integrations.github_installations (installation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_github_installation_connection
  ON integrations.github_installations (connection_id)
  WHERE connection_id IS NOT NULL;

-- ── Repo links ─────────────────────────────────────────────
-- repo ↔ project with branch → environment mapping. A plain org/project-
-- scoped record now; forward-compatible with re-projection as a manifested
-- resource when P2 lands (the moat consumes the link; it does not own it).

CREATE TABLE IF NOT EXISTS integrations.repo_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  project_id        UUID NOT NULL,
  connection_id     UUID NOT NULL,
  repo_external_id  TEXT NOT NULL,                -- provider repo id (GitHub numeric id)
  repo_full_name    TEXT NOT NULL,                -- e.g. 'acme/storefront'
  default_branch    TEXT,
  branch_env_map    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"main":"prod","staging":"stage"}
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'unlinked')),
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_org
  ON integrations.repo_links (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_project
  ON integrations.repo_links (org_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_connection
  ON integrations.repo_links (connection_id, created_at DESC, id DESC);

-- One ACTIVE link per (project, provider repo); historical unlinked rows remain
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_repo_link_project_repo
  ON integrations.repo_links (project_id, repo_external_id)
  WHERE status = 'active';

-- Event-enrichment lookup: which active links match an inbound repo id
CREATE INDEX IF NOT EXISTS idx_integrations_repo_links_repo
  ON integrations.repo_links (repo_external_id)
  WHERE status = 'active';

-- ── Inbound deliveries ─────────────────────────────────────
-- The durable inbox: both the idempotency ledger (delivery_key UNIQUE per
-- provider — GitHub's X-GitHub-Delivery) and the cron work queue. org_id is
-- NULL until the drain attributes the delivery; emission into event_log is
-- transactional with the 'emitted' mark (exactly-once by construction).

CREATE TABLE IF NOT EXISTS integrations.inbound_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID,                         -- NULL until attributed
  provider          TEXT NOT NULL,
  delivery_key      TEXT NOT NULL,                -- provider delivery id (idempotency key)
  event_type        TEXT NOT NULL,                -- provider event, e.g. 'push'
  action            TEXT,                         -- provider action, e.g. 'opened'
  payload           JSONB NOT NULL,               -- raw provider payload (admin-only)
  signature_ok      BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received', 'attributed', 'emitted', 'skipped', 'failed')),
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ,
  failure_reason    TEXT,                         -- safe summary only
  emitted_event_id  UUID,                         -- event_log id once emitted
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_inbound_delivery_key
  ON integrations.inbound_deliveries (provider, delivery_key);

-- Org-scoped delivery log (sparse until attribution)
CREATE INDEX IF NOT EXISTS idx_integrations_inbound_deliveries_org
  ON integrations.inbound_deliveries (org_id, received_at DESC, id DESC)
  WHERE org_id IS NOT NULL;

-- Cron drain scan: pending work ordered by arrival
CREATE INDEX IF NOT EXISTS idx_integrations_inbound_deliveries_pending
  ON integrations.inbound_deliveries (status, next_attempt_at, received_at)
  WHERE status IN ('received', 'attributed');

-- ── Installation token cache ───────────────────────────────
-- Cache for the platform's OWN provider calls (repo listing, connection
-- health). Brokered tenant tokens are always minted fresh and never cached.
-- token_ciphertext is an AES-256-GCM envelope — write-only, never logged,
-- never exposed through list/read APIs.

CREATE TABLE IF NOT EXISTS integrations.installation_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID NOT NULL,
  token_ciphertext  TEXT NOT NULL,
  permissions       JSONB,
  repository_ids    JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_installation_token_connection
  ON integrations.installation_tokens (connection_id);
