#!/usr/bin/env node
// Placeholders for the fleet's service-binding targets (zero-dependency).
//
// Cloudflare refuses a deploy whose service binding names a Worker that does
// not exist yet (code 10143), and the fleet's bindings form cycles (billing
// <-> membership; membership -> notifications -> events -> membership), so on
// a fresh account no order of first deploys works. 04-workers used to break
// this by deploying the fleet once with the feedback edges stripped from the
// wrangler config (`cycle-break.mjs --strip`) and again, as a second landing
// and a second convergence, with them restored.
//
// This does it with ONE deploy each instead, and 04-workers-restore is gone
// with it. policy-worker binds to nothing, and every worker that holds a
// binding waits on it (an enforced `dependsOn` on main). Its pre-deploy step
// runs this tool, which uploads a placeholder script for every binding target
// in this environment that does not exist yet. Every real deploy then starts
// after the placeholders exist, carries its full bindings, and replaces its
// own placeholder.
//
// Nothing else deploys while this runs (every binding holder waits on it),
// so a placeholder never overwrites a real Worker. On a live product every
// target exists and the tool uploads nothing.
//
//   node tooling/deploy/fleet-stubs.mjs --root ../..            # deploy step
//   node tooling/deploy/fleet-stubs.mjs --root . --env stage --list
//
// The targets come from every apps/*/wrangler{.template,}.jsonc: the
// `services[].service` names of the environment's section. The environment is
// --env, else ORUN_ENVIRONMENT (set by orun on every job). The account and
// token are CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, as the deploy step
// has them; CLOUDFLARE_API_BASE_URL overrides the API (tests).

import * as fs from "node:fs";
import * as path from "node:path";

const COMPAT_DATE = "2025-05-01";
const STUB = `// Placeholder created by tooling/deploy/fleet-stubs.mjs so that the Workers
// binding to this one could deploy first. Its own first deploy replaces it.
export default {
  async fetch() {
    return new Response("not deployed yet", { status: 503 });
  },
};
`;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// JSONC → JSON: drop // and /* */ comments outside strings, then trailing
// commas. Enough for wrangler configs; not a general parser.
export function parseJsonc(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Every service-binding target named by the environment's section of any
// worker config under <root>/apps, sorted and de-duplicated.
export function bindingTargets(root, env) {
  const apps = path.join(root, "apps");
  const targets = new Set();
  for (const app of fs.readdirSync(apps).sort()) {
    for (const name of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
      const file = path.join(apps, app, name);
      if (!fs.existsSync(file)) continue;
      const config = parseJsonc(fs.readFileSync(file, "utf8"));
      const services = [...(config.services ?? []), ...(config.env?.[env]?.services ?? [])];
      for (const s of services) if (s?.service) targets.add(s.service);
      break; // the template when there is one; the rendered file is its output
    }
  }
  return [...targets].sort();
}

async function main() {
  const root = arg("--root", ".");
  const env = arg("--env", process.env.ORUN_ENVIRONMENT || "");
  if (!env) {
    console.error("fleet-stubs: no environment (--env or ORUN_ENVIRONMENT)");
    process.exit(2);
  }
  const targets = bindingTargets(root, env);
  if (process.argv.includes("--list")) {
    for (const t of targets) console.log(t);
    return;
  }
  if (targets.length === 0) {
    console.log(`fleet-stubs: no service bindings in ${env}; nothing to do`);
    return;
  }

  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    console.error("fleet-stubs: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
    process.exit(2);
  }
  const base = (process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  const auth = { Authorization: `Bearer ${token}` };
  const script = (name) => `${base}/accounts/${account}/workers/scripts/${encodeURIComponent(name)}`;

  const created = [];
  const refused = [];
  for (const name of targets) {
    const res = await fetch(`${script(name)}/settings`, { headers: auth });
    if (res.ok) continue;
    if (res.status !== 404) {
      // Not "missing" and not "there": refuse to guess, or a placeholder
      // could replace a real Worker the check failed to see. This one IS
      // fatal — it is a safety property, not a convenience.
      console.error(`fleet-stubs: checking ${name}: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({ main_module: "stub.mjs", compatibility_date: COMPAT_DATE })], { type: "application/json" }));
    form.append("stub.mjs", new Blob([STUB], { type: "application/javascript+module" }), "stub.mjs");
    const put = await fetch(script(name), { method: "PUT", headers: auth, body: form });
    if (!put.ok) {
      // A PLACEHOLDER THAT CANNOT BE MADE IS NOT THIS COMPONENT'S FAILURE.
      //
      // This step runs in policy-worker's pre-deploy, and every binding
      // holder waits on policy-worker with `mode: enforced` — so exiting
      // non-zero here failed the ENTIRE fleet, on both environments, for a
      // placeholder that most of those Workers never needed. It did exactly
      // that on kuyil's own main convergence (2026-10-25): the account was at
      // its 500-Worker limit, `kuyil-billing-worker-stage` could not be
      // created, and ten lanes went red on a step belonging to a component
      // that was itself fine.
      //
      // So: say what happened, and let each real deploy speak for itself. A
      // target that is genuinely still missing when its dependent deploys
      // fails THAT lane with Cloudflare's own 10143, naming the worker that
      // needs it; an account with no room fails the deploy that needs the
      // room, with 10037. Both land on the component the operator must act
      // on, which is never this one.
      refused.push({ name, status: put.status, body: (await put.text()).slice(0, 400) });
      continue;
    }
    created.push(name);
  }

  for (const r of refused) {
    console.error(`fleet-stubs: could not create placeholder ${r.name}: HTTP ${r.status} ${r.body}`);
  }
  if (refused.length) {
    const atLimit = refused.some((r) => r.body.includes("10037") || /limit of \d+ Workers/.test(r.body));
    console.error(
      `fleet-stubs: ${refused.length} of ${targets.length} placeholder(s) in ${env} could not be created; ` +
        `continuing. A Worker whose binding target is still missing will fail its OWN deploy with ` +
        `Cloudflare 10143, naming it.` +
        (atLimit
          ? ` The account is at its Workers limit (10037) — no new script can be created, placeholder or real, ` +
            `until some are deleted; the deploys that need a new script will fail next, for the same reason.`
          : ""),
    );
  }
  console.log(
    created.length
      ? `fleet-stubs: ${created.length} placeholder(s) in ${env}, replaced by each Worker's first deploy: ${created.join(", ")}`
      : refused.length
        ? `fleet-stubs: no placeholder was created in ${env}`
        : `fleet-stubs: all ${targets.length} binding targets in ${env} exist; nothing to do`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`fleet-stubs: ${err?.message ?? err}`);
    process.exit(1);
  });
}
