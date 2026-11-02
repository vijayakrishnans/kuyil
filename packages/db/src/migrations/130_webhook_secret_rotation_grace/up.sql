-- 130_webhook_secret_rotation_grace: dual-secret window for webhook signing-key rotation.
--
-- Context: webhooks
-- Spec: ai/tasks/task-0108.md (B5 webhook secret rotation grace)
--
-- Adds three nullable columns to webhooks.webhook_endpoints so that a rotated
-- endpoint can keep the previous signing secret around for a configurable
-- grace window. During that window the worker delivery loop attaches BOTH
-- the new signature (X-Webhook-Signature) and the previous-key signature
-- (X-Webhook-Signature-Previous), so receivers can roll forward without a
-- delivery gap.
--
-- Design rules:
--   * No backfill — existing rows keep previous_* NULL until the next rotate.
--   * No new secret material persistence shape: the previous ciphertext re-
--     uses the same envelope format as secret_ciphertext (write-only, never
--     returned through any read surface).
--   * Forward-only and idempotent: every column add is `ADD COLUMN IF NOT
--     EXISTS`, safe against the Supabase autocommit runner re-running the
--     migration.
--   * No destructive change to existing columns or constraints.

ALTER TABLE webhooks.webhook_endpoints
  ADD COLUMN IF NOT EXISTS previous_secret_ciphertext   TEXT,
  ADD COLUMN IF NOT EXISTS previous_secret_version      INT,
  ADD COLUMN IF NOT EXISTS previous_secret_expires_at   TIMESTAMPTZ;

COMMENT ON COLUMN webhooks.webhook_endpoints.previous_secret_ciphertext IS
  'Encrypted envelope of the previous signing secret. Populated on rotate, never returned through any read surface. Cleared after previous_secret_expires_at lapses.';

COMMENT ON COLUMN webhooks.webhook_endpoints.previous_secret_version IS
  'Monotonic counter snapshot of secret_version at the moment of the most recent rotate (i.e. the version of the previous secret). NULL on endpoints that have never been rotated.';

COMMENT ON COLUMN webhooks.webhook_endpoints.previous_secret_expires_at IS
  'Wall-clock timestamp at which the previous-key dual-signature window closes. Worker delivery emits X-Webhook-Signature-Previous only while now() < this value.';
