#!/usr/bin/env node
// Console worker size guard (FT5 — specs/profiles/free-tier.md).
//
// The Workers Free plan caps a worker script at 3 MB gzipped, against 10 MB on
// Paid. Every other worker in this fleet gzips to 27–40 KiB and will never come
// near it. The OpenNext console is the exception: it is the only bundle whose
// size is a live constraint, and the only one where a few added dependencies
// can quietly make the free-tier deploy impossible.
//
// This runs in the console's own build lane, where the artifact already exists.
// The platform-limits suite cannot do it: measuring means building Next, which
// is minutes of work in a lane whose value is being cheap enough to always run.
//
// Two things it deliberately does NOT measure:
//
//   - Static assets. They are served from the assets binding, are free and
//     unlimited, and do not count toward the script size limit.
//   - `.open-next/worker.js` on its own. That file is a ~2 KiB entry shim; the
//     48 MB of server-function code it pulls in is what actually ships. Gzipping
//     the shim reports 1 KiB and passes any budget, which is worse than having
//     no guard at all.
//
// So the measurement comes from `wrangler deploy --dry-run`, which performs the
// same bundling the real deploy does and reports the gzipped upload size that
// the platform will actually weigh.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Workers Free, per script, gzipped. Paid raises this to 10 MB. */
const FREE_PLAN_LIMIT_KIB = 3 * 1024;

/**
 * The budget this bundle holds itself to, below the hard cap on purpose.
 *
 * Failing at the cap means failing at deploy time, on the free plan, with no
 * warning — the failure mode this whole profile exists to avoid. The gap
 * between budget and cap is the room to notice and react.
 *
 * Measured at 1880 KiB with `minify: true` (2296 KiB without).
 */
const BUDGET_KIB = 2400;

if (!existsSync(join(APP_DIR, ".open-next", "worker.js"))) {
  console.error("check-worker-size: no OpenNext output — run the build first.");
  process.exit(2);
}

let output;
try {
  output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "deploy", "--dry-run"],
    { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 },
  );
} catch (error) {
  const detail = /** @type {{ stdout?: string; stderr?: string }} */ (error);
  console.error("check-worker-size: wrangler dry-run failed\n", detail.stderr ?? detail.stdout ?? error);
  process.exit(2);
}

// "Total Upload: 8944.37 KiB / gzip: 1879.69 KiB"
const match = /gzip:\s*([\d.]+)\s*KiB/.exec(output);
if (!match) {
  console.error("check-worker-size: could not read the gzip size from wrangler output\n", output);
  process.exit(2);
}

const gzippedKiB = Number(match[1]);
const pctOfCap = (gzippedKiB / FREE_PLAN_LIMIT_KIB) * 100;

// Always reported, not only on failure: the trend is the useful part, and a
// number that appears only when it is already too late is not a guard.
console.log(
  `check-worker-size: ${gzippedKiB.toFixed(0)} KiB gzipped — ` +
    `${pctOfCap.toFixed(0)}% of the free plan's ${FREE_PLAN_LIMIT_KIB} KiB cap ` +
    `(budget ${BUDGET_KIB} KiB)`,
);

if (gzippedKiB > BUDGET_KIB) {
  console.error(
    `\ncheck-worker-size: OVER BUDGET by ${(gzippedKiB - BUDGET_KIB).toFixed(0)} KiB.\n` +
      `\nThe free plan refuses a script over ${FREE_PLAN_LIMIT_KIB} KiB gzipped, so this\n` +
      `budget exists to be hit while there is still room to act. Options, cheapest first:\n` +
      `  - Check what grew: a dependency reaching a server component lands in this\n` +
      `    bundle, whereas one used only in a client component does not.\n` +
      `  - Move work to a route that can be statically rendered — static assets are\n` +
      `    served from the assets binding and cost nothing against this limit.\n` +
      `  - Raise BUDGET_KIB deliberately, and record the new figure in\n` +
      `    specs/profiles/free-tier.md so the headroom stays written down.\n`,
  );
  process.exit(1);
}
