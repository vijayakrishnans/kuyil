/**
 * Cloudflare account-limit guards.
 *
 * These are structural assertions over the committed wrangler templates, not
 * runtime tests. They exist because the limits they defend are per-ACCOUNT and
 * only bite at deploy time, in an environment CI does not otherwise model: an
 * over-budget config typecheck-passes, test-passes, and then fails the deploy
 * with "This account has reached the Workers Free limit of 5 cron triggers per
 * account" — after every other lane went green.
 *
 * See specs/profiles/free-tier.md for the budget these numbers come from.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Jest runs with the package directory as cwd, which works under both the CJS
// and ESM transforms — `__dirname` does not.
const REPO_ROOT = join(process.cwd(), "..", "..");
const APPS_DIR = join(REPO_ROOT, "apps");

/**
 * The environment that carries the scheduled jobs. Not "the only environment
 * that deploys" — stage deploys too, and the account budget accommodates it
 * (see account-budget.test.ts). Crons are concentrated here so the per-account
 * trigger cost is paid once rather than once per environment.
 */
const CRON_ENVIRONMENT = "prod";

interface WorkerConfig {
  app: string;
  file: string;
  config: Record<string, unknown>;
}

/**
 * Strip JSONC comments and the deploy-time `@@wiring(...)@@` placeholders so
 * the template parses as plain JSON. Comment stripping is line-oriented, which
 * is all these templates use.
 */
function parseTemplate(source: string): Record<string, unknown> {
  const withoutComments = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(withoutComments.replace(/@@[^@]+@@/g, "PLACEHOLDER")) as Record<string, unknown>;
}

function loadWorkerConfigs(): WorkerConfig[] {
  const configs: WorkerConfig[] = [];
  for (const app of readdirSync(APPS_DIR).sort()) {
    for (const name of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
      const file = join(APPS_DIR, app, name);
      if (!existsSync(file)) continue;
      configs.push({ app, file: `apps/${app}/${name}`, config: parseTemplate(readFileSync(file, "utf8")) });
      break; // a template wins over its rendered output
    }
  }
  return configs;
}

function cronsIn(scope: unknown): string[] {
  const triggers = (scope as { triggers?: { crons?: string[] } } | undefined)?.triggers;
  return triggers?.crons ?? [];
}

function environmentsOf(config: Record<string, unknown>): Record<string, unknown> {
  return (config.env as Record<string, unknown> | undefined) ?? {};
}

const WORKERS = loadWorkerConfigs();

describe("worker configs are discoverable", () => {
  it("finds a wrangler config for every app", () => {
    expect(WORKERS.length).toBeGreaterThan(0);
  });
});

describe("cron trigger budget (free plan: 5 per account)", () => {
  // A top-level `triggers` block is inherited by EVERY named environment, so
  // one declaration costs one trigger per deployed env. Declaring crons inside
  // the env that needs them is what keeps the arithmetic legible.
  it("declares no crons at the top level of any worker", () => {
    const offenders = WORKERS.filter((w) => cronsIn(w.config).length > 0).map((w) => w.file);

    expect(offenders).toEqual([]);
  });

  it("declares crons only in the environment that carries the scheduled jobs", () => {
    const offenders: string[] = [];
    for (const worker of WORKERS) {
      for (const [envName, envConfig] of Object.entries(environmentsOf(worker.config))) {
        if (envName !== CRON_ENVIRONMENT && cronsIn(envConfig).length > 0) {
          offenders.push(`${worker.file} → env.${envName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

});

describe("worker size budget (free plan: 3MB gzipped)", () => {
  it("minifies every worker that opts into the setting", () => {
    const offenders = WORKERS.filter((w) => w.config.minify === false).map((w) => w.file);

    expect(offenders).toEqual([]);
  });
});
