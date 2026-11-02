-- 090_webhooks_delivery: Webhook delivery runtime prerequisites
-- Fixes event_id type compatibility and adds dispatch cursor tracking.
-- Idempotent: uses IF NOT EXISTS / DO NOTHING throughout for Supabase autocommit runner safety.

-- ── Fix delivery attempt event_id type ───────────────────────
-- events.event_log.id is TEXT (not UUID). The webhook_delivery_attempts.event_id
-- column was created as UUID in migration 080, which is incompatible.
-- ALTER to TEXT to allow canonical event IDs.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'webhooks'
      AND table_name = 'webhook_delivery_attempts'
      AND column_name = 'event_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE webhooks.webhook_delivery_attempts
      ALTER COLUMN event_id TYPE TEXT USING event_id::TEXT;
  END IF;
END $$;

-- ── Idempotency unique constraint ────────────────────────────
-- Prevents duplicate delivery attempts for the same subscription + event + attempt number.
-- ON CONFLICT (subscription_id, event_id, attempt_number) enables safe retry/replay.

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery_sub_event_attempt
  ON webhooks.webhook_delivery_attempts (subscription_id, event_id, attempt_number);

-- ── Webhook dispatch cursor ──────────────────────────────────
-- Tracks the webhook subscriber lane's progress through the canonical event log.
-- Each org has its own cursor position. Progress advances only after delivery
-- work is durably recorded.

CREATE TABLE IF NOT EXISTS webhooks.webhook_dispatch_cursor (
  org_id          TEXT NOT NULL,
  subscriber_lane TEXT NOT NULL DEFAULT 'webhooks',
  last_event_id   TEXT,             -- last event_id successfully processed
  last_occurred_at TIMESTAMPTZ,     -- last event occurred_at for cursor ordering
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, subscriber_lane)
);

-- ── Retryable delivery index ─────────────────────────────────
-- Supports efficient polling for delivery attempts needing retry.

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retryable
  ON webhooks.webhook_delivery_attempts (next_retry_at ASC, status)
  WHERE status = 'retrying' AND next_retry_at IS NOT NULL;

-- ── Subscription matching index ──────────────────────────────
-- Supports efficient fanout: find all enabled subscriptions for an org + event type.

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_fanout
  ON webhooks.webhook_subscriptions (org_id, event_type)
  WHERE enabled = true;
