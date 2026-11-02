/**
 * Free-tier profile — the scheduled-pass delivery budget.
 *
 * The budget exists because the Workers Free plan gives one invocation 10ms of
 * CPU and 50 subrequests, and every delivery costs an outbound fetch. These
 * tests pin the two properties that make a shrunken pass safe rather than
 * merely smaller: it stops at the ceiling, and it never advances the dispatch
 * cursor past work it did not do.
 */

import { dispatchNewEvents, retryFailedDeliveries } from "@webhooks-worker/delivery";
import {
  deliveryBudget,
  isFreeTier,
  FREE_BUDGET,
  PAID_BUDGET,
  type DeliveryBudget,
} from "@webhooks-worker/free-tier";
import type { Env } from "@webhooks-worker/env";
import type { MatchedSubscription, WebhookDeliveryAttempt } from "@saas/db/webhooks";
import type { StoredEvent } from "@saas/db/events";

const ORG = "11111111-1111-1111-1111-111111111111";
const ENDPOINT = "44444444-4444-4444-4444-444444444444";

function makeEvent(id: string): StoredEvent {
  return {
    id,
    type: "project.created",
    version: 1,
    source: "projects-worker",
    occurredAt: new Date("2026-05-29T10:00:00Z"),
    actorType: "user",
    actorId: "usr_abc",
    actorSessionId: null,
    actorIp: null,
    orgId: ORG,
    projectId: null,
    environmentId: null,
    subjectKind: "project",
    subjectId: "prj_xyz",
    subjectName: null,
    requestId: "req_test",
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: {},
    redactPaths: [],
    createdAt: new Date("2026-05-29T10:00:00Z"),
  } as StoredEvent;
}

function makeSubs(count: number): MatchedSubscription[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sub-${i}`,
    orgId: ORG,
    endpointId: ENDPOINT,
    projectId: null,
    eventType: "project.created",
  })) as MatchedSubscription[];
}

/** Records the ceilings the dispatcher pushes down into the repository. */
function createRecordingRepo(subs: MatchedSubscription[], retryable: WebhookDeliveryAttempt[] = []) {
  const calls = {
    eventLimits: [] as number[],
    retryLimits: [] as number[],
    advancedCursors: [] as string[],
    createdAttempts: 0,
  };
  const repo = {
    _calls: calls,
    async listActiveOrgIds() {
      return { ok: true, value: [ORG] };
    },
    async getDispatchCursor(orgId: string) {
      return {
        ok: true,
        value: { orgId, subscriberLane: "webhooks", lastEventId: null, lastOccurredAt: null, updatedAt: new Date(0) },
      };
    },
    async advanceDispatchCursor(orgId: string, lastEventId: string) {
      calls.advancedCursors.push(lastEventId);
      return { ok: true, value: { orgId, subscriberLane: "webhooks", lastEventId, lastOccurredAt: null, updatedAt: new Date() } };
    },
    async findMatchingSubscriptions() {
      return { ok: true, value: subs };
    },
    async createDeliveryAttempt(input: { id: string }) {
      calls.createdAttempts += 1;
      return {
        ok: true,
        value: {
          id: input.id,
          orgId: ORG,
          endpointId: ENDPOINT,
          eventType: "project.created",
          status: "pending",
          attemptNumber: 1,
        },
      };
    },
    async getEndpointForDelivery() {
      return {
        ok: true,
        value: { id: ENDPOINT, orgId: ORG, url: "https://example.com/webhook", signingSecret: null, status: "active" },
      };
    },
    async updateDeliveryAttempt() {
      return { ok: true, value: {} };
    },
    async countConsecutiveFailures() {
      return { ok: true, value: 0 };
    },
    async listRetryableDeliveries(limit: number) {
      calls.retryLimits.push(limit);
      return { ok: true, value: retryable };
    },
  };
  return repo;
}

function createEventsRepo(events: StoredEvent[], eventLimits: number[]) {
  return {
    async queryEventsByOrg(_orgId: string, _since: unknown, _sinceId: unknown, limit: number) {
      eventLimits.push(limit);
      return { ok: true, value: events };
    },
    async appendEvent(input: unknown) {
      return { ok: true, value: input };
    },
    async appendEventWithAudit(input: { event: unknown }) {
      return { ok: true, value: { event: input.event, audit: {} } };
    },
  };
}

function ctxFor(repo: ReturnType<typeof createRecordingRepo>, events: StoredEvent[]) {
  return {
    webhookRepo: repo,
    eventsRepo: createEventsRepo(events, repo._calls.eventLimits),
    encryption: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ── The switch ───────────────────────────────────────────────

describe("free-tier switch", () => {
  it("is off unless the var is exactly \"true\"", () => {
    expect(isFreeTier({} as Env)).toBe(false);
    expect(isFreeTier({ FREE_TIER: "false" } as Env)).toBe(false);
    expect(isFreeTier({ FREE_TIER: "TRUE" } as Env)).toBe(false);
    expect(isFreeTier({ FREE_TIER: "1" } as Env)).toBe(false);
    expect(isFreeTier({ FREE_TIER: "true" } as Env)).toBe(true);
  });

  it("defaults to the paid baseline and opts in to the free budget", () => {
    expect(deliveryBudget({} as Env)).toBe(PAID_BUDGET);
    expect(deliveryBudget({ FREE_TIER: "true" } as Env)).toBe(FREE_BUDGET);
  });

  it("keeps the free budget inside the free plan's 50-subrequest ceiling", () => {
    expect(FREE_BUDGET.maxDeliveriesPerPass).toBeLessThan(50);
    expect(FREE_BUDGET.maxRetryBatch).toBeLessThanOrEqual(FREE_BUDGET.maxDeliveriesPerPass);
    // The paid baseline is deliberately unbounded — it has 10,000 subrequests.
    expect(PAID_BUDGET.maxDeliveriesPerPass).toBe(Number.POSITIVE_INFINITY);
  });
});

// ── Budget enforcement ───────────────────────────────────────

describe("dispatchNewEvents under a budget", () => {
  let fetchCount: number;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCount = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("claims only maxEventsPerOrg events from the event log", async () => {
    const repo = createRecordingRepo(makeSubs(1));
    await dispatchNewEvents(ctxFor(repo, [makeEvent("evt_1")]), FREE_BUDGET);

    expect(repo._calls.eventLimits).toEqual([FREE_BUDGET.maxEventsPerOrg]);
  });

  it("stops delivering at maxDeliveriesPerPass", async () => {
    const budget: DeliveryBudget = { maxEventsPerOrg: 10, maxRetryBatch: 10, maxDeliveriesPerPass: 2 };
    const repo = createRecordingRepo(makeSubs(5));

    const result = await dispatchNewEvents(ctxFor(repo, [makeEvent("evt_1")]), budget);

    expect(result.dispatched).toBe(2);
    expect(fetchCount).toBe(2);
  });

  it("does not advance the cursor past a partially fanned-out event", async () => {
    // 5 subscriptions, budget of 2: three subscribers never saw evt_1, so the
    // cursor must stay put or they would silently lose the event forever.
    const budget: DeliveryBudget = { maxEventsPerOrg: 10, maxRetryBatch: 10, maxDeliveriesPerPass: 2 };
    const repo = createRecordingRepo(makeSubs(5));

    await dispatchNewEvents(ctxFor(repo, [makeEvent("evt_1")]), budget);

    expect(repo._calls.advancedCursors).toEqual([]);
  });

  it("advances the cursor for events fanned out completely", async () => {
    const budget: DeliveryBudget = { maxEventsPerOrg: 10, maxRetryBatch: 10, maxDeliveriesPerPass: 5 };
    const repo = createRecordingRepo(makeSubs(1));

    await dispatchNewEvents(ctxFor(repo, [makeEvent("evt_1"), makeEvent("evt_2")]), budget);

    // Both events fit; the cursor lands on the last one handled.
    expect(repo._calls.advancedCursors).toEqual(["evt_2"]);
  });

  it("stops between events once the budget is spent, leaving the cursor on the last complete one", async () => {
    const budget: DeliveryBudget = { maxEventsPerOrg: 10, maxRetryBatch: 10, maxDeliveriesPerPass: 2 };
    const repo = createRecordingRepo(makeSubs(1));

    const result = await dispatchNewEvents(
      ctxFor(repo, [makeEvent("evt_1"), makeEvent("evt_2"), makeEvent("evt_3")]),
      budget,
    );

    expect(result.dispatched).toBe(2);
    expect(repo._calls.advancedCursors).toEqual(["evt_2"]);
  });
});

describe("retryFailedDeliveries under a budget", () => {
  it("passes the batch ceiling down to the repository", async () => {
    const repo = createRecordingRepo(makeSubs(1));
    await retryFailedDeliveries(ctxFor(repo, []), 7);

    expect(repo._calls.retryLimits).toEqual([7]);
  });

  it("is a no-op when dispatch already spent the pass's budget", async () => {
    const repo = createRecordingRepo(makeSubs(1));
    const result = await retryFailedDeliveries(ctxFor(repo, []), 0);

    expect(result).toEqual({ retried: 0, errors: 0 });
    // Never even asks the database — a query is itself a subrequest.
    expect(repo._calls.retryLimits).toEqual([]);
  });

  it("defaults to the paid batch size when no ceiling is given", async () => {
    const repo = createRecordingRepo(makeSubs(1));
    await retryFailedDeliveries(ctxFor(repo, []));

    expect(repo._calls.retryLimits).toEqual([PAID_BUDGET.maxRetryBatch]);
  });
});
