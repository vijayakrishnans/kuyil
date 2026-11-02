/**
 * Free-tier profile — the inbox drain's per-pass batch size.
 *
 * On the Workers Free plan a scheduled invocation gets 10ms of CPU and 50
 * subrequests. Each inbound delivery costs several Hyperdrive round trips, so
 * the batch size is what decides whether a tick finishes or is killed
 * mid-flight. These tests pin the switch and the ceiling it pushes into the
 * claim query.
 */

import { drainInboundDeliveries } from "@integrations-worker/drain";
import {
  drainBatchSize,
  isFreeTier,
  FREE_DRAIN_BATCH_SIZE,
  PAID_DRAIN_BATCH_SIZE,
} from "@integrations-worker/free-tier";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    ...overrides,
  } as unknown as Env;
}

/** Records every statement so the claim query's LIMIT can be asserted. */
function recordingExecutor(): { executor: SqlExecutor; queries: Array<{ text: string; params: unknown[] }> } {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      return { ok: true, rows: [] as T[], rowCount: 0 } as unknown as SqlExecutorResult<T>;
    },
  } as unknown as SqlExecutor;
  return { executor, queries };
}

/** The batch size the drain pushed into its "claim due rows" query. */
function claimedLimit(queries: Array<{ text: string; params: unknown[] }>): unknown {
  const claim = queries.find((q) => q.text.includes("inbound_deliveries"));
  expect(claim).toBeDefined();
  return claim!.params[claim!.params.length - 1];
}

describe("free-tier switch", () => {
  it("is off unless the var is exactly \"true\"", () => {
    expect(isFreeTier(createEnv())).toBe(false);
    expect(isFreeTier(createEnv({ FREE_TIER: "false" }))).toBe(false);
    expect(isFreeTier(createEnv({ FREE_TIER: "TRUE" }))).toBe(false);
    expect(isFreeTier(createEnv({ FREE_TIER: "true" }))).toBe(true);
  });

  it("defaults to the paid batch size and opts in to the free one", () => {
    expect(drainBatchSize(createEnv())).toBe(PAID_DRAIN_BATCH_SIZE);
    expect(drainBatchSize(createEnv({ FREE_TIER: "true" }))).toBe(FREE_DRAIN_BATCH_SIZE);
  });

  it("keeps the free batch inside the free plan's 50-subrequest ceiling", () => {
    expect(FREE_DRAIN_BATCH_SIZE).toBeLessThan(50);
    expect(FREE_DRAIN_BATCH_SIZE).toBeLessThan(PAID_DRAIN_BATCH_SIZE);
  });
});

describe("drainInboundDeliveries batch sizing", () => {
  it("claims the paid batch by default", async () => {
    const { executor, queries } = recordingExecutor();
    await drainInboundDeliveries(executor, createEnv());

    expect(claimedLimit(queries)).toBe(PAID_DRAIN_BATCH_SIZE);
  });

  it("claims the free batch when the profile is on", async () => {
    const { executor, queries } = recordingExecutor();
    await drainInboundDeliveries(executor, createEnv({ FREE_TIER: "true" }));

    expect(claimedLimit(queries)).toBe(FREE_DRAIN_BATCH_SIZE);
  });

  it("still honours an explicit override", async () => {
    const { executor, queries } = recordingExecutor();
    await drainInboundDeliveries(executor, createEnv({ FREE_TIER: "true" }), { batchSize: 3 });

    expect(claimedLimit(queries)).toBe(3);
  });
});
