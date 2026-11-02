-- 110_billing_foundation: Billing persistence foundation
-- Creates the billing bounded-context schema with provider-neutral storage for
-- plans, billing customers, subscriptions, invoices, and entitlements.
--
-- Design rules:
--  * Organization is the V1 billing customer boundary; per-project billing is
--    a future extension. Every org-scoped table carries org_id directly.
--  * Provider-specific fields (provider, provider_*_id, hosted_url) are opaque
--    references only; they are never the source of truth for product
--    entitlement decisions.
--  * No secret/credential material: no API keys, webhook signing secrets,
--    bearer tokens, plaintext payment data, raw provider payloads, or
--    checkout session secrets. metadata columns are bounded safe metadata only.
--  * Billing consumes normalized metering outputs (rollups). It does not own
--    raw usage facts and does not mutate metering-owned tables.
--  * Idempotent: CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS throughout for the
--    Supabase autocommit runner. No destructive rewrites of applied state.

-- ── Schema ─────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS billing;

COMMENT ON SCHEMA billing IS
  'Billing bounded context — provider-neutral plans, billing customers, '
  'subscriptions, invoices, and entitlements. Owns plan/subscription/entitlement '
  'state. Consumes normalized metering rollups; never owns raw usage facts.';

-- ── Plans ──────────────────────────────────────────────────
-- Catalog of available plan definitions. Plans are global (not org-scoped) —
-- they are the menu organizations subscribe to. Nominal display price fields
-- are present for catalog UI; live provider pricing remains opaque per-plan.

CREATE TABLE IF NOT EXISTS billing.plans (
  id                TEXT        NOT NULL,
  code              TEXT        NOT NULL,                  -- stable machine identifier (e.g. 'starter', 'pro')
  name              TEXT        NOT NULL,                  -- human-facing display name
  description       TEXT,
  status            TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'archived'
  billing_interval  TEXT        NOT NULL DEFAULT 'month',  -- 'month' | 'year' | 'none'
  price_amount_cents BIGINT,                               -- nominal display price; provider is source of truth
  price_currency    TEXT        NOT NULL DEFAULT 'usd',    -- ISO-4217 lowercase
  metadata          JSONB,                                 -- bounded safe metadata (no secrets, tokens, credentials)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id),

  CONSTRAINT chk_plan_status   CHECK (status IN ('active', 'archived')),
  CONSTRAINT chk_plan_interval CHECK (billing_interval IN ('month', 'year', 'none')),
  CONSTRAINT chk_plan_price    CHECK (price_amount_cents IS NULL OR price_amount_cents >= 0)
);

COMMENT ON TABLE billing.plans IS
  'Provider-neutral plan catalog. Plans are global; organizations subscribe to '
  'plans via billing.subscriptions. Plans drive entitlement defaults; payment '
  'provider mappings live in provider-side state, not here.';

COMMENT ON COLUMN billing.plans.metadata IS
  'Bounded safe metadata only — must never contain bearer tokens, API keys, '
  'provider credentials, connection strings, webhook signing secrets, or '
  'plaintext secret material.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_code ON billing.plans (code);
CREATE INDEX IF NOT EXISTS idx_plan_status    ON billing.plans (status);

-- ── Billing customers ──────────────────────────────────────
-- One billing customer per organization for V1. The provider_customer_id is an
-- opaque reference to an external payment-provider customer record; provider
-- credentials and API keys are stored elsewhere (Secrets Store), never here.

CREATE TABLE IF NOT EXISTS billing.billing_customers (
  id                    TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  display_name          TEXT,
  email                 TEXT,
  status                TEXT        NOT NULL DEFAULT 'active', -- 'active' | 'inactive'
  provider              TEXT,                                  -- e.g. 'stripe' (opaque adapter id)
  provider_customer_id  TEXT,                                  -- opaque external customer ref
  metadata              JSONB,                                 -- bounded safe metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id),

  CONSTRAINT chk_billing_customer_status CHECK (status IN ('active', 'inactive'))
);

COMMENT ON TABLE billing.billing_customers IS
  'One billing customer per organization (V1). provider_customer_id is an opaque '
  'reference to the payment-provider record; provider credentials/secrets are '
  'stored in Secrets Store and never persisted here.';

COMMENT ON COLUMN billing.billing_customers.metadata IS
  'Bounded safe metadata only — must never contain bearer tokens, API keys, '
  'provider credentials, raw provider payloads, or plaintext secret material.';

-- V1 invariant: one billing customer per org
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_customer_org
  ON billing.billing_customers (org_id);

-- Provider lookup (sparse)
CREATE INDEX IF NOT EXISTS idx_billing_customer_provider
  ON billing.billing_customers (provider, provider_customer_id)
  WHERE provider IS NOT NULL;

-- ── Subscriptions ──────────────────────────────────────────
-- Subscriptions link an organization billing customer to a plan with lifecycle
-- state. Provider-side ids are opaque; status drives entitlement gating.

CREATE TABLE IF NOT EXISTS billing.subscriptions (
  id                       TEXT        NOT NULL,
  org_id                   TEXT        NOT NULL,
  billing_customer_id      TEXT        NOT NULL,  -- opaque ref to billing.billing_customers(id)
  plan_id                  TEXT        NOT NULL,  -- opaque ref to billing.plans(id)
  status                   TEXT        NOT NULL DEFAULT 'active',
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  trial_end                TIMESTAMPTZ,
  cancel_at                TIMESTAMPTZ,
  canceled_at              TIMESTAMPTZ,
  provider                 TEXT,
  provider_subscription_id TEXT,
  metadata                 JSONB,                  -- bounded safe metadata
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id),

  CONSTRAINT chk_subscription_status CHECK (
    status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')
  )
);

COMMENT ON TABLE billing.subscriptions IS
  'Organization-scoped subscription state. Status drives entitlement gating; '
  'provider ids are opaque references for adapter mapping only.';

COMMENT ON COLUMN billing.subscriptions.metadata IS
  'Bounded safe metadata only — must never contain bearer tokens, API keys, '
  'provider credentials, raw webhook payloads, or plaintext secret material.';

CREATE INDEX IF NOT EXISTS idx_subscription_org_status
  ON billing.subscriptions (org_id, status);

CREATE INDEX IF NOT EXISTS idx_subscription_customer
  ON billing.subscriptions (billing_customer_id);

CREATE INDEX IF NOT EXISTS idx_subscription_plan
  ON billing.subscriptions (plan_id);

CREATE INDEX IF NOT EXISTS idx_subscription_provider
  ON billing.subscriptions (provider, provider_subscription_id)
  WHERE provider IS NOT NULL;

-- ── Invoices ───────────────────────────────────────────────
-- Mirror of provider-issued invoices. Sufficient for future provider webhooks
-- to reflect provider invoice state into starter-owned state. We never store
-- raw provider payloads, full card data, or signing secrets.

CREATE TABLE IF NOT EXISTS billing.invoices (
  id                    TEXT        NOT NULL,
  org_id                TEXT        NOT NULL,
  billing_customer_id   TEXT        NOT NULL,
  subscription_id       TEXT,                                    -- opaque ref; nullable for one-off invoices
  number                TEXT,                                    -- provider-issued invoice number (safe display)
  status                TEXT        NOT NULL DEFAULT 'draft',
  amount_due_cents      BIGINT      NOT NULL DEFAULT 0,
  amount_paid_cents     BIGINT      NOT NULL DEFAULT 0,
  currency              TEXT        NOT NULL DEFAULT 'usd',
  issued_at             TIMESTAMPTZ,
  due_at                TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  provider              TEXT,
  provider_invoice_id   TEXT,
  hosted_url            TEXT,                                    -- safe display URL only; no embedded secret token query strings
  metadata              JSONB,                                   -- bounded safe metadata
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id),

  CONSTRAINT chk_invoice_status CHECK (
    status IN ('draft', 'open', 'paid', 'void', 'uncollectible')
  ),
  CONSTRAINT chk_invoice_amounts CHECK (
    amount_due_cents >= 0 AND amount_paid_cents >= 0
  )
);

COMMENT ON TABLE billing.invoices IS
  'Provider invoice mirror. Stores enough state to display invoice history and '
  'reconcile webhooks. Raw provider payloads, full card numbers, CVCs, signing '
  'secrets, and bearer tokens MUST NOT be persisted here.';

COMMENT ON COLUMN billing.invoices.hosted_url IS
  'Safe display URL only. Callers must reject URLs that embed bearer tokens, '
  'session secrets, or other credential material in query strings or fragments.';

COMMENT ON COLUMN billing.invoices.metadata IS
  'Bounded safe metadata only — must never contain bearer tokens, API keys, '
  'provider credentials, raw provider payloads, full payment instrument data, '
  'or plaintext secret material.';

CREATE INDEX IF NOT EXISTS idx_invoice_org_issued
  ON billing.invoices (org_id, issued_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_invoice_customer
  ON billing.invoices (billing_customer_id, issued_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_invoice_subscription
  ON billing.invoices (subscription_id)
  WHERE subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_provider
  ON billing.invoices (provider, provider_invoice_id)
  WHERE provider IS NOT NULL AND provider_invoice_id IS NOT NULL;

-- ── Entitlements ───────────────────────────────────────────
-- Organization-scoped, queryable feature/limit grants. Derived from plan
-- defaults at subscription creation/change time; explicit per-org overrides
-- are allowed. Future policy/product surfaces query by (org_id, key).

CREATE TABLE IF NOT EXISTS billing.entitlements (
  id              TEXT        NOT NULL,
  org_id          TEXT        NOT NULL,
  subscription_id TEXT,                                  -- opaque ref; nullable for plan-independent grants
  entitlement_key TEXT        NOT NULL,                  -- stable machine key (e.g. 'feature.custom_domains', 'limit.projects')
  value_type      TEXT        NOT NULL,                  -- 'boolean' | 'quantity' | 'feature'
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  limit_value     BIGINT,                                -- optional numeric limit; NULL = unlimited (when enabled)
  source          TEXT        NOT NULL DEFAULT 'plan',   -- 'plan' | 'override'
  metadata        JSONB,                                 -- bounded safe metadata
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id),

  CONSTRAINT chk_entitlement_value_type CHECK (value_type IN ('boolean', 'quantity', 'feature')),
  CONSTRAINT chk_entitlement_source     CHECK (source IN ('plan', 'override')),
  CONSTRAINT chk_entitlement_limit      CHECK (limit_value IS NULL OR limit_value >= 0)
);

COMMENT ON TABLE billing.entitlements IS
  'Organization-scoped entitlement grants. Queryable by (org_id, entitlement_key) '
  'for policy and product surfaces. Plan-derived entries use source=plan; '
  'manual per-org grants use source=override.';

COMMENT ON COLUMN billing.entitlements.metadata IS
  'Bounded safe metadata only — must never contain bearer tokens, API keys, '
  'provider credentials, or plaintext secret material.';

-- Unique per (org_id, entitlement_key): callers replace via upsert
CREATE UNIQUE INDEX IF NOT EXISTS uq_entitlement_org_key
  ON billing.entitlements (org_id, entitlement_key);

CREATE INDEX IF NOT EXISTS idx_entitlement_subscription
  ON billing.entitlements (subscription_id)
  WHERE subscription_id IS NOT NULL;
