// Free-tier profile — the inbox drain's per-pass batch size (FREE_TIER).
//
// On the Workers Free plan a scheduled invocation gets 10 ms of CPU and 50
// subrequests, against 30 s and 10,000 on Paid. Each inbound delivery costs
// several Hyperdrive round trips (claim → normalize → emit → mark), so the
// paid-baseline batch of 50 cannot finish inside a free-plan tick.
//
// Design contract (specs/profiles/free-tier.md): budget, don't disable. The
// drain already claims due rows oldest-first and re-queues what it does not
// finish, so a smaller batch drains the same inbox over more minutes.

import type { Env } from "./env";

/** Paid baseline — bounded for a 30 s / 10,000-subrequest invocation. */
export const PAID_DRAIN_BATCH_SIZE = 50;

/** Free plan — sized so one pass stays well inside 50 subrequests. */
export const FREE_DRAIN_BATCH_SIZE = 10;

/**
 * Is this instance running the free-tier profile? Deploy-time wrangler var; an
 * absent or non-"true" value means the paid baseline (the safe default — the
 * free-tier profile is strictly opt-in).
 */
export function isFreeTier(env: Env): boolean {
  return env.FREE_TIER === "true";
}

/** Inbound deliveries one drain pass claims. */
export function drainBatchSize(env: Env): number {
  return isFreeTier(env) ? FREE_DRAIN_BATCH_SIZE : PAID_DRAIN_BATCH_SIZE;
}
