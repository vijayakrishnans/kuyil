/**
 * Service-binding chain audit.
 *
 * On the Workers Free plan a request gets 50 subrequests and, on either plan,
 * a hard cap of 32 worker invocations. Every service-binding hop spends one of
 * each. Worse for the free tier, CPU time is summed across the whole chain and
 * billed as one request — so chain depth is what makes the CPU cost of a route
 * unknowable, and it is the one part of that cost measurable from the repo
 * alone.
 *
 * What this suite does NOT claim: that the longest chain is what any real
 * request walks. It is a static upper bound over the bindings a worker
 * declares, not a trace. A route eight workers deep is not necessarily over
 * 10ms — but nothing in the repo can tell you it is under, and a bound that
 * grows silently is how you find out in production.
 *
 * See specs/profiles/free-tier.md, "The chained-CPU constraint".
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(process.cwd(), "..", "..");
const APPS_DIR = join(REPO_ROOT, "apps");

/** Hard platform cap, both plans: worker invocations per request. */
const MAX_WORKER_INVOCATIONS = 32;

/**
 * The depth this fleet holds itself to. Well under the platform cap on
 * purpose: the cap is where the request dies, not where it becomes a problem.
 * Every hop added here is CPU spent inside one shared 10ms budget on free, and
 * a serialize/parse round trip on either plan.
 */
const CHAIN_BUDGET = 12;

/** Measured today. Named so growth is a visible edit, not a silent drift. */
const DEEPEST = { entry: "api-edge", depth: 8 };

/**
 * Cycles in the binding graph, reviewed and accepted.
 *
 * A cycle means static analysis cannot bound the chain at all — the only limit
 * is the platform's 32-invocation cap, reached by a bug rather than by design.
 * These two are real and long-standing; the guard exists so a *third* is a
 * decision somebody makes on purpose.
 */
const ACCEPTED_CYCLES = [
  "billing-worker → membership-worker → billing-worker",
  "membership-worker → notifications-worker → events-worker → membership-worker",
];

export type Graph = Record<string, string[]>;

function parseJsonc(source: string): unknown {
  const withoutComments = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(withoutComments.replace(/@@[^@]+@@/g, "PLACEHOLDER"));
}

/** Service-binding edges as deployed to prod, keyed by component directory. */
export function bindingGraph(): Graph {
  const graph: Graph = {};
  for (const app of readdirSync(APPS_DIR).sort()) {
    const file = ["wrangler.template.jsonc", "wrangler.jsonc"]
      .map((n) => join(APPS_DIR, app, n))
      .find(existsSync);
    if (!file) continue;

    const config = parseJsonc(readFileSync(file, "utf8")) as {
      env?: Record<string, { services?: Array<{ service: string }> }>;
    };
    const services = config.env?.prod?.services ?? [];
    graph[app] = services
      .map((s) => s.service.replace(/^kuyil-/, "").replace(/-prod$/, ""))
      .sort();
  }
  return graph;
}

/**
 * Worker invocations on the longest chain starting at `entry`, counting the
 * entry worker itself. Simple paths only — a node is never revisited — which
 * is what makes the number finite in the presence of cycles.
 */
export function longestChain(graph: Graph, entry: string, visited = new Set([entry])): number {
  let deepest = 1;
  for (const next of graph[entry] ?? []) {
    if (visited.has(next)) continue;
    deepest = Math.max(deepest, 1 + longestChain(graph, next, new Set([...visited, next])));
  }
  return deepest;
}

/** Every distinct cycle, rendered as an arrow-joined path. */
export function findCycles(graph: Graph): string[] {
  const found = new Map<string, string>();

  const walk = (node: string, stack: string[]): void => {
    for (const next of graph[node] ?? []) {
      const seenAt = stack.indexOf(next);
      if (seenAt !== -1) {
        const cycle = [...stack.slice(seenAt), next];
        // Key on the member set so the same loop found from different entry
        // points is reported once.
        const key = [...new Set(cycle)].sort().join(",");
        if (!found.has(key)) found.set(key, cycle.join(" → "));
        continue;
      }
      walk(next, [...stack, next]);
    }
  };

  for (const node of Object.keys(graph).sort()) walk(node, [node]);
  return [...found.values()].sort();
}

const GRAPH = bindingGraph();

// ── The analysis functions themselves ────────────────────────

describe("chain analysis", () => {
  it("counts the entry worker and every hop", () => {
    expect(longestChain({ a: ["b"], b: ["c"], c: [] }, "a")).toBe(3);
    expect(longestChain({ a: [] }, "a")).toBe(1);
  });

  it("takes the deepest branch, not the first", () => {
    expect(longestChain({ a: ["b", "c"], b: [], c: ["d"], d: [] }, "a")).toBe(3);
  });

  it("stays finite through a cycle by never revisiting a node", () => {
    expect(longestChain({ a: ["b"], b: ["a"] }, "a")).toBe(2);
  });

  it("reports a cycle once, however many entry points reach it", () => {
    expect(findCycles({ a: ["b"], b: ["c"], c: ["b"] })).toEqual(["b → c → b"]);
  });

  it("reports no cycle for a plain tree", () => {
    expect(findCycles({ a: ["b", "c"], b: [], c: [] })).toEqual([]);
  });
});

// ── The fleet ────────────────────────────────────────────────

describe("the binding graph is discoverable", () => {
  it("finds workers with service bindings", () => {
    expect(Object.values(GRAPH).filter((v) => v.length > 0).length).toBeGreaterThan(5);
  });
});

describe("chain depth (free plan: one 10ms CPU budget across the chain)", () => {
  const depths = Object.keys(GRAPH)
    .map((entry) => ({ entry, depth: longestChain(GRAPH, entry) }))
    .sort((a, b) => b.depth - a.depth);

  it("has not deepened since it was last measured", () => {
    // A single number, so a new binding that lengthens the worst-case chain
    // shows up as a deliberate edit here and in the profile spec.
    expect(depths[0]).toEqual(DEEPEST);
  });

  it("stays inside the fleet's own chain budget", () => {
    const over = depths.filter((d) => d.depth > CHAIN_BUDGET);

    expect(over).toEqual([]);
  });

  it("stays far inside the platform's invocation cap", () => {
    expect(CHAIN_BUDGET).toBeLessThan(MAX_WORKER_INVOCATIONS);
    expect(depths[0]!.depth).toBeLessThan(MAX_WORKER_INVOCATIONS);
  });
});

describe("cycles in the binding graph", () => {
  it("contains only the cycles that have been reviewed", () => {
    // Not a ban: these two are long-standing and the fleet works. The point is
    // that a third cannot arrive unnoticed, because a cycle is the one shape
    // static analysis cannot bound.
    expect(findCycles(GRAPH)).toEqual(ACCEPTED_CYCLES);
  });
});
