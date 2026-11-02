// Wallet bounded context — double-entry money for Kuyil.
//
// Every movement is ONE transfer whose legs sum to zero. The database
// enforces the rest (210_wallet_ledger): user balances cannot go negative,
// a transfer that does not balance cannot commit, postings are append-only.
// Callers run these inside `executor.transaction(...)` so a post and the
// deposit it holds, or a purchase and the access it grants, land together.

import type { SqlExecutor } from "../hyperdrive/index.js";
import { pgArray } from "../social/index.js";

export const CURRENCY = "INR";
/** Kuyil's cut of tips, creator subscriptions and curation sales (6%). */
export const FEE_BPS = 600;
/** Kuyil's cut of a forfeited spam deposit (20%); the recipient keeps the rest. */
export const FORFEIT_CUT_BPS = 2000;
/** Deposit a stranger's reply holds in escrow (₹2). */
export const DEPOSIT_MINOR = 200;
/** One-off human check (₹1). */
export const VERIFY_MINOR = 100;
/** How long a deposit waits for the recipient before it auto-refunds. */
export const DEPOSIT_TTL_HOURS = 24;
export const SUBSCRIPTION_DAYS = 30;

export type TransferKind =
  | "topup" | "payout" | "tip" | "creator_sub" | "curation_purchase" | "verify"
  | "deposit_hold" | "deposit_refund" | "deposit_forfeit";

export type Owner =
  | { kind: "user"; userId: string }
  | { kind: "platform" }
  | { kind: "escrow" }
  | { kind: "external" };

export interface Leg { owner: Owner; amountMinor: number }

export interface TransferInput {
  kind: TransferKind;
  actorId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  refPostId?: string | null | undefined;
  refCurationId?: string | null | undefined;
  refUserId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  legs: Leg[];
}

export type WalletErrorCode = "insufficient_funds" | "invalid_amount" | "not_found" | "forbidden" | "already_settled";

export class WalletError extends Error {
  constructor(public readonly code: WalletErrorCode, message: string) {
    super(message);
    this.name = "WalletError";
  }
}

/** Integer fee in minor units, rounded down (the creator keeps the remainder). */
export function feeOf(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps) / 10_000);
}

/** Split of a gross amount into what the payee nets and what Kuyil keeps. */
export function splitWithFee(amountMinor: number, bps = FEE_BPS): { net: number; fee: number } {
  const fee = feeOf(amountMinor, bps);
  return { net: amountMinor - fee, fee };
}

/** True when a Postgres error is the overdraft guard on a user account. */
export function isInsufficientFunds(err: unknown): boolean {
  const e = err as { constraint_name?: string; constraint?: string; message?: string } | null;
  const name = e?.constraint_name ?? e?.constraint ?? "";
  return name === "accounts_user_nonnegative" || /accounts_user_nonnegative/.test(e?.message ?? "");
}

export function validateLegs(legs: Leg[]): void {
  if (legs.length < 2) throw new WalletError("invalid_amount", "A transfer needs at least two legs");
  let sum = 0;
  for (const l of legs) {
    if (!Number.isSafeInteger(l.amountMinor) || l.amountMinor === 0) {
      throw new WalletError("invalid_amount", "Leg amounts must be non-zero integers (minor units)");
    }
    sum += l.amountMinor;
  }
  if (sum !== 0) throw new WalletError("invalid_amount", `Legs must sum to zero (got ${sum})`);
}

async function accountId(tx: SqlExecutor, owner: Owner, currency = CURRENCY): Promise<string> {
  const ownerId = owner.kind === "user" ? owner.userId : null;
  await tx.execute(
    `INSERT INTO wallet.accounts (id, owner_kind, owner_id, currency)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [owner.kind, ownerId, currency],
  );
  const r = await tx.execute<{ id: string }>(
    `SELECT id FROM wallet.accounts
      WHERE owner_kind = $1 AND owner_id IS NOT DISTINCT FROM $2 AND currency = $3`,
    [owner.kind, ownerId, currency],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("wallet: account could not be resolved");
  return id;
}

/**
 * Write one balanced transfer. With an idempotency key, a repeat of the same
 * (actor, key) returns the first transfer instead of moving money twice.
 */
export async function postTransfer(
  tx: SqlExecutor,
  input: TransferInput,
): Promise<{ transferId: string; replayed: boolean }> {
  validateLegs(input.legs);
  // ON CONFLICT rather than check-then-insert: two concurrent retries serialize
  // on the unique index, and the loser replays instead of failing with a 500.
  const t = await tx.execute<{ id: string }>(
    `INSERT INTO wallet.transfers (id, kind, actor_id, idempotency_key, ref_post_id, ref_curation_id, ref_user_id, metadata)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      input.kind, input.actorId ?? null, input.idempotencyKey ?? null,
      input.refPostId ?? null, input.refCurationId ?? null, input.refUserId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  if (!t.rows[0]) {
    const prior = await tx.execute<{ id: string }>(
      `SELECT id FROM wallet.transfers WHERE actor_id = $1 AND idempotency_key = $2`,
      [input.actorId, input.idempotencyKey],
    );
    return { transferId: prior.rows[0]!.id, replayed: true };
  }
  const transferId = t.rows[0]!.id;
  // Debits first, so an overdraft fails before any credit is written.
  const ordered = [...input.legs].sort((a, b) => a.amountMinor - b.amountMinor);
  for (const leg of ordered) {
    const acct = await accountId(tx, leg.owner);
    await tx.execute(
      `INSERT INTO wallet.postings (transfer_id, account_id, amount_minor) VALUES ($1, $2, $3)`,
      [transferId, acct, leg.amountMinor],
    );
  }
  return { transferId, replayed: false };
}

const user = (userId: string): Owner => ({ kind: "user", userId });
const PLATFORM: Owner = { kind: "platform" };
const ESCROW: Owner = { kind: "escrow" };
const EXTERNAL: Owner = { kind: "external" };

/** Payer → payee with Kuyil's fee taken from the gross amount. */
function feeLegs(from: string, to: string, gross: number): Leg[] {
  const { net, fee } = splitWithFee(gross);
  const legs: Leg[] = [{ owner: user(from), amountMinor: -gross }, { owner: user(to), amountMinor: net }];
  if (fee > 0) legs.push({ owner: PLATFORM, amountMinor: fee });
  return legs;
}

export async function tip(
  tx: SqlExecutor,
  p: { from: string; to: string; amountMinor: number; postId: string; idempotencyKey?: string | null },
) {
  if (p.from === p.to) throw new WalletError("forbidden", "You can't tip yourself");
  if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor < 100 || p.amountMinor > 10_000_00) {
    throw new WalletError("invalid_amount", "Tips are between ₹1 and ₹10,000");
  }
  return postTransfer(tx, {
    kind: "tip", actorId: p.from, idempotencyKey: p.idempotencyKey, refPostId: p.postId, refUserId: p.to,
    metadata: { grossMinor: p.amountMinor }, legs: feeLegs(p.from, p.to, p.amountMinor),
  });
}

export async function subscribeCreator(
  tx: SqlExecutor,
  p: { subscriber: string; creator: string; priceMinor: number; idempotencyKey?: string | null },
) {
  if (p.subscriber === p.creator) throw new WalletError("forbidden", "You can't subscribe to yourself");
  const { transferId, replayed } = await postTransfer(tx, {
    kind: "creator_sub", actorId: p.subscriber, idempotencyKey: p.idempotencyKey, refUserId: p.creator,
    metadata: { grossMinor: p.priceMinor }, legs: feeLegs(p.subscriber, p.creator, p.priceMinor),
  });
  if (!replayed) {
    // A renewal extends from the end of the current window, never overlaps it.
    await tx.execute(
      `INSERT INTO wallet.creator_subscriptions (subscriber_id, creator_id, transfer_id, starts_at, ends_at)
       SELECT $1, $2, $3, s, s + make_interval(days => $4)
         FROM (SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) AS s
                 FROM wallet.creator_subscriptions WHERE subscriber_id = $1 AND creator_id = $2) w`,
      [p.subscriber, p.creator, transferId, SUBSCRIPTION_DAYS],
    );
  }
  return { transferId, replayed };
}

export async function purchaseCuration(
  tx: SqlExecutor,
  p: { buyer: string; owner: string; curationId: string; priceMinor: number; idempotencyKey?: string | null },
) {
  return postTransfer(tx, {
    kind: "curation_purchase", actorId: p.buyer, idempotencyKey: p.idempotencyKey,
    refCurationId: p.curationId, refUserId: p.owner, metadata: { grossMinor: p.priceMinor },
    legs: feeLegs(p.buyer, p.owner, p.priceMinor),
  });
}

export async function verifyHuman(tx: SqlExecutor, userId: string) {
  return postTransfer(tx, {
    kind: "verify", actorId: userId, idempotencyKey: "verify",
    legs: [{ owner: user(userId), amountMinor: -VERIFY_MINOR }, { owner: PLATFORM, amountMinor: VERIFY_MINOR }],
  });
}

/** Money in from outside (UPI / Stripe / Lightning webhook, or a stage dev top-up). */
export async function topUp(tx: SqlExecutor, p: { userId: string; amountMinor: number; idempotencyKey: string; source: string }) {
  return postTransfer(tx, {
    kind: "topup", actorId: p.userId, idempotencyKey: p.idempotencyKey, metadata: { source: p.source },
    legs: [{ owner: EXTERNAL, amountMinor: -p.amountMinor }, { owner: user(p.userId), amountMinor: p.amountMinor }],
  });
}

export async function holdDeposit(
  tx: SqlExecutor,
  p: { payer: string; payee: string; postId: string; amountMinor?: number | undefined },
) {
  const amount = p.amountMinor ?? DEPOSIT_MINOR;
  const { transferId } = await postTransfer(tx, {
    kind: "deposit_hold", actorId: p.payer, refPostId: p.postId, refUserId: p.payee,
    legs: [{ owner: user(p.payer), amountMinor: -amount }, { owner: ESCROW, amountMinor: amount }],
  });
  await tx.execute(
    `INSERT INTO wallet.reply_deposits (post_id, payer_id, payee_id, amount_minor, hold_transfer_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [p.postId, p.payer, p.payee, amount, transferId, DEPOSIT_TTL_HOURS],
  );
  return { transferId, amountMinor: amount };
}

export type DepositRow = {
  post_id: string; payer_id: string; payee_id: string; amount_minor: string | number;
  status: "held" | "refunded" | "forfeited"; expires_at: string; created_at: string;
};

/**
 * Settle a held deposit. `actorId` must be the payee, or null for the expiry
 * sweep (which may only refund). Row-locked so two clicks can't settle twice.
 */
export async function settleDeposit(
  tx: SqlExecutor,
  p: { postId: string; outcome: "refund" | "forfeit"; actorId: string | null },
) {
  const r = await tx.execute<DepositRow>(
    `SELECT * FROM wallet.reply_deposits WHERE post_id = $1 FOR UPDATE`, [p.postId],
  );
  const d = r.rows[0];
  if (!d) throw new WalletError("not_found", "No deposit on that reply");
  if (d.status !== "held") throw new WalletError("already_settled", `Deposit already ${d.status}`);
  if (p.actorId !== null && p.actorId !== d.payee_id) throw new WalletError("forbidden", "Only the recipient can settle this deposit");
  if (p.actorId === null && p.outcome !== "refund") throw new WalletError("forbidden", "Expiry can only refund");
  const amount = Number(d.amount_minor);
  let legs: Leg[];
  if (p.outcome === "refund") {
    legs = [{ owner: ESCROW, amountMinor: -amount }, { owner: user(d.payer_id), amountMinor: amount }];
  } else {
    const cut = feeOf(amount, FORFEIT_CUT_BPS);
    legs = [{ owner: ESCROW, amountMinor: -amount }, { owner: user(d.payee_id), amountMinor: amount - cut }];
    if (cut > 0) legs.push({ owner: PLATFORM, amountMinor: cut });
  }
  const { transferId } = await postTransfer(tx, {
    kind: p.outcome === "refund" ? "deposit_refund" : "deposit_forfeit",
    actorId: p.actorId, refPostId: p.postId, refUserId: d.payer_id, legs,
  });
  await tx.execute(
    `UPDATE wallet.reply_deposits SET status = $2, settle_transfer_id = $3, settled_at = now() WHERE post_id = $1`,
    [p.postId, p.outcome === "refund" ? "refunded" : "forfeited", transferId],
  );
  return { transferId, status: p.outcome === "refund" ? "refunded" : "forfeited" };
}

/** Ids of held deposits past their expiry (for the cron sweep). */
export async function expiredDeposits(ex: SqlExecutor, limit = 200): Promise<string[]> {
  const r = await ex.execute<{ post_id: string }>(
    `SELECT post_id FROM wallet.reply_deposits WHERE status = 'held' AND expires_at < now() ORDER BY expires_at LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => x.post_id);
}

export async function balance(ex: SqlExecutor, userId: string): Promise<number> {
  const r = await ex.execute<{ b: string | number }>(
    `SELECT balance_minor AS b FROM wallet.accounts WHERE owner_kind = 'user' AND owner_id = $1 AND currency = $2`,
    [userId, CURRENCY],
  );
  return Number(r.rows[0]?.b ?? 0);
}

export type HistoryRow = { transfer_id: string; kind: TransferKind; amount_minor: string | number; ref_post_id: string | null; ref_user_id: string | null; actor_id: string | null; created_at: string };

export async function history(ex: SqlExecutor, userId: string, limit = 50): Promise<HistoryRow[]> {
  const r = await ex.execute<HistoryRow>(
    `SELECT t.id AS transfer_id, t.kind, p.amount_minor, t.ref_post_id, t.ref_user_id, t.actor_id, t.created_at
       FROM wallet.postings p
       JOIN wallet.accounts a ON a.id = p.account_id
       JOIN wallet.transfers t ON t.id = p.transfer_id
      WHERE a.owner_kind = 'user' AND a.owner_id = $1
      ORDER BY p.id DESC LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
}

export async function heldDepositsFor(ex: SqlExecutor, payeeId: string): Promise<DepositRow[]> {
  const r = await ex.execute<DepositRow>(
    `SELECT * FROM wallet.reply_deposits WHERE payee_id = $1 AND status = 'held' ORDER BY created_at DESC LIMIT 100`,
    [payeeId],
  );
  return r.rows;
}

export async function depositsForPosts(ex: SqlExecutor, postIds: string[]): Promise<Map<string, DepositRow>> {
  if (!postIds.length) return new Map();
  const r = await ex.execute<DepositRow>(`SELECT * FROM wallet.reply_deposits WHERE post_id = ANY($1::uuid[])`, [pgArray(postIds)]);
  return new Map(r.rows.map((d) => [d.post_id, d]));
}

/** Gross tip totals per post (for the Hot formula and the tip counter). */
export async function tipTotals(ex: SqlExecutor, postIds: string[]): Promise<Map<string, number>> {
  if (!postIds.length) return new Map();
  const r = await ex.execute<{ post_id: string; total: string | number }>(
    `SELECT ref_post_id AS post_id, SUM((metadata->>'grossMinor')::bigint) AS total
       FROM wallet.transfers WHERE kind = 'tip' AND ref_post_id = ANY($1::uuid[]) GROUP BY ref_post_id`,
    [pgArray(postIds)],
  );
  return new Map(r.rows.map((x) => [x.post_id, Number(x.total)]));
}

/** Creators this viewer currently has an active subscription to, among `creatorIds`. */
export async function activeSubscriptions(ex: SqlExecutor, subscriber: string, creatorIds: string[]): Promise<Set<string>> {
  if (!creatorIds.length) return new Set();
  const r = await ex.execute<{ creator_id: string }>(
    `SELECT DISTINCT creator_id FROM wallet.creator_subscriptions
      WHERE subscriber_id = $1 AND creator_id = ANY($2::uuid[]) AND starts_at <= now() AND ends_at > now()`,
    [subscriber, pgArray(creatorIds)],
  );
  return new Set(r.rows.map((x) => x.creator_id));
}

export async function verifiedUsers(ex: SqlExecutor, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const r = await ex.execute<{ actor_id: string }>(
    `SELECT DISTINCT actor_id FROM wallet.transfers WHERE kind = 'verify' AND actor_id = ANY($1::uuid[])`, [pgArray(userIds)],
  );
  return new Set(r.rows.map((x) => x.actor_id));
}

/** Platform revenue by source, in minor units. */
export async function revenue(ex: SqlExecutor): Promise<Record<string, number>> {
  const r = await ex.execute<{ kind: string; total: string | number }>(
    `SELECT t.kind, SUM(p.amount_minor) AS total
       FROM wallet.postings p
       JOIN wallet.accounts a ON a.id = p.account_id AND a.owner_kind = 'platform'
       JOIN wallet.transfers t ON t.id = p.transfer_id
      GROUP BY t.kind`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.total)]));
}
