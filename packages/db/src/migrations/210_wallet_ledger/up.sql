-- 210_wallet_ledger
-- Kuyil wallet — a double-entry ledger. Every money movement is one transfer
-- whose postings sum to zero (enforced by a deferred constraint trigger), user
-- balances can never go negative (CHECK on the cached balance), and postings
-- are append-only. Reply deposits and creator subscriptions are tracked as
-- their own facts pointing at the transfers that moved the money.
-- Bounded context: wallet
-- Idempotent: uses IF NOT EXISTS / CREATE OR REPLACE throughout.
-- Amounts are integer minor units (paise / cents). No floating point money.
-- No cross-context foreign keys: post / curation / user ids are bare UUIDs.

CREATE SCHEMA IF NOT EXISTS wallet;

COMMENT ON SCHEMA wallet IS 'Wallet bounded context — owns accounts, transfers, postings, reply deposits and creator subscriptions.';

-- ============================================================
-- Accounts. One per (owner_kind, owner_id, currency).
--   user     — a person's spendable balance (never negative)
--   platform — Kuyil's revenue (fees)
--   escrow   — held reply deposits
--   external — the outside world (top-ups in, payouts out); may go negative
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet.accounts (
  id             UUID        PRIMARY KEY,
  owner_kind     TEXT        NOT NULL,
  owner_id       UUID,
  currency       TEXT        NOT NULL DEFAULT 'INR',
  balance_minor  BIGINT      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT accounts_owner_kind_check CHECK (owner_kind IN ('user', 'platform', 'escrow', 'external')),
  CONSTRAINT accounts_owner_id_check CHECK ((owner_kind = 'user') = (owner_id IS NOT NULL)),
  CONSTRAINT accounts_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT accounts_user_nonnegative CHECK (owner_kind <> 'user' OR balance_minor >= 0),
  CONSTRAINT accounts_escrow_nonnegative CHECK (owner_kind <> 'escrow' OR balance_minor >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_owner_idx
  ON wallet.accounts (owner_kind, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'), currency);

-- ============================================================
-- Transfers: the business event. idempotency_key makes a retried
-- request a no-op instead of a double charge.
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet.transfers (
  id               UUID        PRIMARY KEY,
  kind             TEXT        NOT NULL,
  actor_id         UUID,
  idempotency_key  TEXT,
  ref_post_id      UUID,
  ref_curation_id  UUID,
  ref_user_id      UUID,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT transfers_kind_check CHECK (kind IN (
    'topup', 'payout', 'tip', 'creator_sub', 'curation_purchase', 'verify',
    'deposit_hold', 'deposit_refund', 'deposit_forfeit'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS transfers_idempotency_idx
  ON wallet.transfers (actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS transfers_kind_created_idx ON wallet.transfers (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_post_idx ON wallet.transfers (ref_post_id) WHERE ref_post_id IS NOT NULL;

-- ============================================================
-- Postings: the legs. Signed amounts; a transfer's legs sum to 0.
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet.postings (
  id            BIGSERIAL   PRIMARY KEY,
  transfer_id   UUID        NOT NULL REFERENCES wallet.transfers (id),
  account_id    UUID        NOT NULL REFERENCES wallet.accounts (id),
  amount_minor  BIGINT      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT postings_nonzero CHECK (amount_minor <> 0)
);

CREATE INDEX IF NOT EXISTS postings_account_idx ON wallet.postings (account_id, id DESC);
CREATE INDEX IF NOT EXISTS postings_transfer_idx ON wallet.postings (transfer_id);

-- Keep the cached balance in step with every posting. The CHECKs on
-- wallet.accounts then reject an overdraft inside the same transaction.
CREATE OR REPLACE FUNCTION wallet.apply_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE wallet.accounts
     SET balance_minor = balance_minor + NEW.amount_minor
   WHERE id = NEW.account_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS postings_apply ON wallet.postings;
CREATE TRIGGER postings_apply
  AFTER INSERT ON wallet.postings
  FOR EACH ROW EXECUTE FUNCTION wallet.apply_posting();

-- Every transfer must balance by commit time.
CREATE OR REPLACE FUNCTION wallet.check_transfer_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  total BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0) INTO total
    FROM wallet.postings WHERE transfer_id = NEW.transfer_id;
  IF total <> 0 THEN
    RAISE EXCEPTION 'wallet transfer % does not balance (sum %)', NEW.transfer_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS postings_balanced ON wallet.postings;
CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON wallet.postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION wallet.check_transfer_balanced();

-- Postings are history: never edited, never deleted.
CREATE OR REPLACE FUNCTION wallet.reject_posting_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet.postings is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS postings_append_only ON wallet.postings;
CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON wallet.postings
  FOR EACH ROW EXECUTE FUNCTION wallet.reject_posting_change();

-- ============================================================
-- Reply deposits: a stranger's reply holds money in escrow until the
-- recipient refunds or forfeits it, or it expires (auto-refund).
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet.reply_deposits (
  post_id             UUID        PRIMARY KEY,
  payer_id            UUID        NOT NULL,
  payee_id            UUID        NOT NULL,
  amount_minor        BIGINT      NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'held',
  hold_transfer_id    UUID        NOT NULL REFERENCES wallet.transfers (id),
  settle_transfer_id  UUID        REFERENCES wallet.transfers (id),
  expires_at          TIMESTAMPTZ NOT NULL,
  settled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reply_deposits_status_check CHECK (status IN ('held', 'refunded', 'forfeited')),
  CONSTRAINT reply_deposits_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT reply_deposits_settlement_check CHECK ((status = 'held') = (settled_at IS NULL))
);

CREATE INDEX IF NOT EXISTS reply_deposits_payee_held_idx
  ON wallet.reply_deposits (payee_id, created_at DESC) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS reply_deposits_expiry_idx
  ON wallet.reply_deposits (expires_at) WHERE status = 'held';

-- ============================================================
-- Creator subscriptions: a paid 30-day window per period.
-- ============================================================
CREATE TABLE IF NOT EXISTS wallet.creator_subscriptions (
  subscriber_id  UUID        NOT NULL,
  creator_id     UUID        NOT NULL,
  transfer_id    UUID        NOT NULL REFERENCES wallet.transfers (id),
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subscriber_id, creator_id, starts_at),
  CONSTRAINT creator_subscriptions_window CHECK (ends_at > starts_at),
  CONSTRAINT creator_subscriptions_not_self CHECK (subscriber_id <> creator_id)
);

CREATE INDEX IF NOT EXISTS creator_subscriptions_active_idx
  ON wallet.creator_subscriptions (subscriber_id, creator_id, ends_at DESC);
