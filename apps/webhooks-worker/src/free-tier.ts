// Free-tier profile — the per-worker scheduled-pass budget (FREE_TIER).
//
// On the Workers Free plan a single invocation gets 10 ms of CPU and 50
// subrequests, against 30 s and 10,000 on Paid. The dispatcher spends one
// outbound `fetch` per delivery, so the paid-baseline batch sizes below are
// not merely slow on free — `MAX_RETRY_BATCH = 100` exceeds the subrequest
// ceiling twice over and the pass is killed mid-flight.
//
// Design contract (specs/profiles/free-tier.md):
//   - Budget, don't disable. The same dispatch and retry code runs; only how
//     much of the backlog one pass claims changes. The cursor and the retry
//     schedule already make a pass resumable, so a smaller batch drains the
//     same queue over more minutes rather than dropping work.
//   - One switch, off by default in code, so the paid baseline is what you
//     get unless the operator opts in.

import type { Env } from "./env";

/** Per-pass ceilings for one scheduled dispatch + retry sweep. */
export interface DeliveryBudget {
  /** Events claimed per org per pass. */
  maxEventsPerOrg: number;
  /** Retryable attempts claimed per pass. */
  maxRetryBatch: number;
  /**
   * Hard ceiling on outbound deliveries per pass — the subrequest governor.
   * Dispatch and retry draw from one budget because they share an invocation.
   */
  maxDeliveriesPerPass: number;
}

/** Paid baseline: bounded, but bounded for a 30 s / 10,000-subrequest budget. */
export const PAID_BUDGET: DeliveryBudget = {
  maxEventsPerOrg: 50,
  maxRetryBatch: 100,
  maxDeliveriesPerPass: Number.POSITIVE_INFINITY,
};

// Free plan: 50 subrequests per invocation, shared by every Hyperdrive query
// and every outbound delivery in the pass. 20 deliveries leaves ~30 for the
// cursor reads, subscription lookups and attempt writes around them.
export const FREE_BUDGET: DeliveryBudget = {
  maxEventsPerOrg: 10,
  maxRetryBatch: 10,
  maxDeliveriesPerPass: 20,
};

/**
 * Is this instance running the free-tier profile? Deploy-time wrangler var; an
 * absent or non-"true" value means the paid baseline (the safe default — the
 * free-tier profile is strictly opt-in).
 */
export function isFreeTier(env: Env): boolean {
  return env.FREE_TIER === "true";
}

/** The budget one scheduled pass runs under. */
export function deliveryBudget(env: Env): DeliveryBudget {
  return isFreeTier(env) ? FREE_BUDGET : PAID_BUDGET;
}
