/**
 * Cloudflare per-account budget.
 *
 * The limits that broke this account are per-ACCOUNT, not per-worker, so no
 * single config is ever wrong on its own — the arithmetic across every
 * component and every deployed environment is. This suite computes that
 * arithmetic from the repo and asserts it fits.
 *
 * It prices the deployed set rather than forbidding a shape. The distinction
 * matters: `cloudflare-account-limits.test.ts` bans a top-level `triggers`
 * block because it is confusing, but banning it is a style rule and style
 * rules can be argued with. This suite instead charges a top-level block what
 * it actually costs — one trigger per deployed environment, exactly the
 * inheritance that produced 6 against a limit of 5 — so a regression fails
 * with the number rather than with an opinion.
 *
 * See specs/profiles/free-tier.md.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(process.cwd(), "..", "..");

/** Workers Free, per account. Paid raises all three substantially. */
const FREE_PLAN = {
  cronTriggers: 5,
  workerScripts: 100,
  hyperdriveConfigs: 10,
} as const;

/**
 * Cron slots deliberately left unspent. Spending one is a real decision about
 * a shared account resource, so it should be a visible edit to this number and
 * to the profile spec — not something a new component quietly absorbs.
 */
const RESERVED_CRON_SLOTS = 2;

interface WranglerConfig {
  triggers?: { crons?: string[] };
  env?: Record<string, { triggers?: { crons?: string[] } }>;
}

interface Deployment {
  component: string;
  type: string;
  environment: string;
}

function parseJsonc(source: string): unknown {
  const withoutComments = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(withoutComments.replace(/@@[^@]+@@/g, "PLACEHOLDER"));
}

/**
 * Cron triggers a worker attaches when deployed to `environment`.
 *
 * Wrangler inherits a top-level `triggers` block into every named environment
 * unless that environment declares its own. Exported and unit-tested below,
 * because this rule is the whole reason the account went over budget and a
 * guard that got it wrong would be worse than no guard.
 */
export function effectiveCrons(config: WranglerConfig, environment: string): string[] {
  const scoped = config.env?.[environment]?.triggers;
  if (scoped) return scoped.crons ?? [];
  return config.triggers?.crons ?? [];
}

/** Every (component, environment) pair that a main-push convergence deploys. */
function deployedSet(): Deployment[] {
  const out: Deployment[] = [];
  const roots = ["apps", "infra", join("infra", "terraform")];

  for (const root of roots) {
    const dir = join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry, "component.yaml");
      if (!existsSync(file)) continue;
      const src = readFileSync(file, "utf8");
      const type = /^ {2}type:\s*(\S+)/m.exec(src)?.[1] ?? "unknown";
      const subscribe = src.split("subscribe:")[1];
      if (!subscribe) continue;

      // Each `- name: <env>` item, with the indented block that follows it.
      const items = subscribe.matchAll(/^ {6}- name: (\w+)\n((?: {8}.*\n|\n)*)/gm);
      for (const item of items) {
        if (/profile:\s*(deploy|apply)\b/.test(item[2]!)) {
          out.push({ component: entry, type, environment: item[1]! });
        }
      }
    }
  }
  return out;
}

function wranglerFor(component: string): WranglerConfig | null {
  for (const name of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
    const file = join(REPO_ROOT, "apps", component, name);
    if (existsSync(file)) return parseJsonc(readFileSync(file, "utf8")) as WranglerConfig;
  }
  return null;
}

const DEPLOYED = deployedSet();

// ── The pricing rule itself ──────────────────────────────────

describe("cron pricing follows wrangler inheritance", () => {
  it("charges a top-level block to every environment that deploys", () => {
    const config: WranglerConfig = {
      triggers: { crons: ["* * * * *"] },
      env: { dev: {}, stage: {}, prod: {} },
    };

    // This is the shape that put the account at 6/5: one declaration, but a
    // cost paid once per deployed environment.
    expect(effectiveCrons(config, "stage")).toEqual(["* * * * *"]);
    expect(effectiveCrons(config, "prod")).toEqual(["* * * * *"]);
  });

  it("lets an environment override the inherited block", () => {
    const config: WranglerConfig = {
      triggers: { crons: ["* * * * *"] },
      env: { stage: { triggers: { crons: [] } }, prod: { triggers: { crons: ["5 * * * *"] } } },
    };

    expect(effectiveCrons(config, "stage")).toEqual([]);
    expect(effectiveCrons(config, "prod")).toEqual(["5 * * * *"]);
  });

  it("charges nothing when neither level declares triggers", () => {
    expect(effectiveCrons({ env: { prod: {} } }, "prod")).toEqual([]);
  });
});

// ── The account budget ───────────────────────────────────────

describe("the deployed set is discoverable", () => {
  it("finds components that deploy", () => {
    expect(DEPLOYED.length).toBeGreaterThan(10);
  });

  it("deploys stage and prod", () => {
    expect([...new Set(DEPLOYED.map((d) => d.environment))].sort()).toEqual(["prod", "stage"]);
  });
});

describe("cron triggers (free plan: 5 per account)", () => {
  const charged = DEPLOYED.flatMap(({ component, environment }) => {
    const config = wranglerFor(component);
    if (!config) return [];
    return effectiveCrons(config, environment).map(
      (cron) => `${component} · ${environment}: ${cron}`,
    );
  }).sort();

  it("spends exactly the budget the profile documents", () => {
    // Itemised rather than counted, so a failure names which jobs are
    // competing for the account's slots.
    expect(charged).toEqual([
      "integrations-worker · prod: * * * * *",
      "metering-worker · prod: 5 * * * *",
      "webhooks-worker · prod: * * * * *",
    ]);
  });

  it("stays inside the account limit, with the reserved slots intact", () => {
    expect(charged.length).toBeLessThanOrEqual(FREE_PLAN.cronTriggers - RESERVED_CRON_SLOTS);
  });
});

describe("other per-account resources", () => {
  it("keeps worker scripts inside the free plan's 100", () => {
    const scripts = DEPLOYED.filter((d) => d.type.startsWith("cloudflare-worker"));

    expect(scripts.length).toBeLessThanOrEqual(FREE_PLAN.workerScripts);
  });

  it("keeps Hyperdrive configs inside the free plan's 10", () => {
    const configs = DEPLOYED.filter((d) => d.component === "cloudflare-hyperdrive");

    expect(configs.length).toBeLessThanOrEqual(FREE_PLAN.hyperdriveConfigs);
  });
});
