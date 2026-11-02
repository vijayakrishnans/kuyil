-- 080_webhooks_core: Webhook persistence foundation
-- Creates the webhooks schema with endpoint, subscription, and delivery-attempt tables.
-- Idempotent: uses IF NOT EXISTS throughout for Supabase autocommit runner safety.

CREATE SCHEMA IF NOT EXISTS webhooks;

-- ── Webhook endpoints ──────────────────────────────────────
-- Organization-owned webhook endpoint metadata with optional project scope.
-- Signing secret material is never stored in plaintext; only encrypted envelope
-- and version metadata are persisted.

CREATE TABLE IF NOT EXISTS webhooks.webhook_endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  project_id      UUID,
  url             TEXT NOT NULL,
  name            TEXT,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled', 'pending')),
  disabled_reason TEXT,
  disabled_at     TIMESTAMPTZ,

  -- Signing secret metadata (no plaintext secret values)
  secret_version          INT NOT NULL DEFAULT 1,
  secret_ciphertext       TEXT,           -- encrypted envelope, write-only
  secret_last_rotated_at  TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Project-scoped endpoints must carry org_id + project_id
  CONSTRAINT chk_webhook_endpoint_project_scope
    CHECK (project_id IS NULL OR org_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org
  ON webhooks.webhook_endpoints (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org_project
  ON webhooks.webhook_endpoints (org_id, project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

-- ── Webhook subscriptions ──────────────────────────────────
-- Endpoint-bound event subscription configuration.
-- Each subscription binds an endpoint to an event type or pattern.

CREATE TABLE IF NOT EXISTS webhooks.webhook_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  endpoint_id     UUID NOT NULL,
  project_id      UUID,
  event_type      TEXT NOT NULL,         -- e.g. 'project.created', 'member.*'
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Project-scoped subscriptions must carry org_id + project_id
  CONSTRAINT chk_webhook_sub_project_scope
    CHECK (project_id IS NULL OR org_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_endpoint
  ON webhooks.webhook_subscriptions (endpoint_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_org
  ON webhooks.webhook_subscriptions (org_id, created_at DESC, id DESC);

-- Unique constraint: one subscription per endpoint + event_type + project scope
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_sub_endpoint_event
  ON webhooks.webhook_subscriptions (
    endpoint_id,
    event_type,
    COALESCE(project_id, '00000000-0000-0000-0000-000000000000')
  );

-- ── Webhook delivery attempts ──────────────────────────────
-- Safe delivery bookkeeping. Stores response metadata and safe failure reasons
-- only — no full event payloads or customer response bodies.

CREATE TABLE IF NOT EXISTS webhooks.webhook_delivery_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL,
  endpoint_id       UUID NOT NULL,
  subscription_id   UUID NOT NULL,
  event_id          UUID NOT NULL,
  event_type        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
  attempt_number    INT NOT NULL DEFAULT 1,
  http_status_code  INT,
  failure_reason    TEXT,              -- safe summary, no raw response body
  idempotency_key   TEXT,              -- deduplication key for retry safety
  next_retry_at     TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_org
  ON webhooks.webhook_delivery_attempts (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhooks.webhook_delivery_attempts (endpoint_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhooks.webhook_delivery_attempts (subscription_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhooks.webhook_delivery_attempts (event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_idempotency
  ON webhooks.webhook_delivery_attempts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
