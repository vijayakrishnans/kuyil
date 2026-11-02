/**
 * Secret-scoping guards.
 *
 * Component-level `secretEnv` is environment-blind: orun attaches it to every
 * job of the component, in every environment it subscribes, as a REQUIRED
 * reference. A ref that also hard-codes an environment segment therefore makes
 * a dev job require a stage or prod credential it never reads — and, because
 * resolution happens before the first step, a missing or unreadable value kills
 * the lane with `Secret not found` before any work runs.
 *
 * That is not hypothetical. It is what turned one revoked Supabase connection
 * into a fleet-wide CI outage on 2026-08-06: `cloudflare-hyperdrive` could not
 * publish WIRING_CLOUDFLARE_HYPERDRIVE, and twelve components required it in
 * all three environments, including dev lanes that render offline from
 * `wiring.fixture.json` and never touch the document.
 *
 * The composition states the contract these guards defend
 * (`cloudflare-worker-turbo-verify.yaml`):
 *
 *   "Offline fixture render only — verify lanes must never need cloud
 *    credentials (BF6 D5 guard); wire-live is deploy-only."
 *
 * Declare such refs per-environment, under `subscribe.environments[]`, so only
 * the environments that deploy carry them.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(process.cwd(), "..", "..");
const ROOTS = ["apps", "infra/terraform", "infra"];

/** `secret://<workspace>/<project>/<env>/<KEY>` with a literal environment. */
const HARDCODED_ENV_REF = /secret:\/\/[^/]+\/[^/]+\/(dev|stage|prod)\//;

interface Offender {
  component: string;
  detail: string;
}

function componentFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    const dir = join(REPO_ROOT, root);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const file = join(dir, entry, "component.yaml");
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Indentation width of a line, ignoring blank lines. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Collect the entries of every `secretEnv` / `optionalSecretEnv` block, tagged
 * with the indentation the block was declared at. 2 = component-level (applies
 * to every environment); 8 = inside a `subscribe.environments[]` item.
 *
 * Line-oriented rather than a YAML parse: these files are hand-written in one
 * consistent style, and the guard should not pull a parser into a lane whose
 * whole job is to be cheap and always run.
 */
function secretBlocks(source: string): Array<{ key: string; indent: number; entries: string[] }> {
  const blocks: Array<{ key: string; indent: number; entries: string[] }> = [];
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(secretEnv|optionalSecretEnv):\s*$/.exec(lines[i]!);
    if (!match) continue;

    const indent = match[1]!.length;
    const entries: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      if (indentOf(line) <= indent) break;
      entries.push(line.trim());
    }
    blocks.push({ key: match[2]!, indent, entries });
  }
  return blocks;
}

const COMPONENTS = componentFiles().map((file) => ({
  name: file.replace(`${REPO_ROOT}/`, ""),
  blocks: secretBlocks(readFileSync(file, "utf8")),
}));

describe("components are discoverable", () => {
  it("finds component.yaml files to check", () => {
    expect(COMPONENTS.length).toBeGreaterThan(10);
  });

  it("finds at least one scoped secretEnv block", () => {
    const scoped = COMPONENTS.filter((c) =>
      c.blocks.some((b) => b.key === "secretEnv" && b.indent > 2),
    );

    expect(scoped.length).toBeGreaterThan(0);
  });
});

describe("required secrets are environment-scoped", () => {
  // A component-level `secretEnv` is attached to EVERY environment. Combined
  // with a hard-coded environment in the ref, that is the defect: a dev job
  // required to resolve a prod credential.
  it("declares no component-level required secret that hard-codes an environment", () => {
    const offenders: Offender[] = [];
    for (const component of COMPONENTS) {
      for (const block of component.blocks) {
        if (block.key !== "secretEnv" || block.indent !== 2) continue;
        for (const entry of block.entries) {
          if (HARDCODED_ENV_REF.test(entry)) {
            offenders.push({ component: component.name, detail: entry.split(":")[0]! });
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // `{{ .environment }}` is always fine at component level: the ref resolves to
  // the running job's own environment, so no job reaches across.
  it("allows component-level required secrets templated on the environment", () => {
    const templated = COMPONENTS.flatMap((c) =>
      c.blocks
        .filter((b) => b.key === "secretEnv" && b.indent === 2)
        .flatMap((b) => b.entries)
        .filter((e) => e.includes("{{ .environment }}")),
    );

    // The infra components rely on this form; if it ever disappears, the guard
    // above has stopped being meaningful and this test says so.
    expect(templated.length).toBeGreaterThan(0);
  });
});

describe("scoped blocks use a form orun actually honours", () => {
  // Verified against the planner: `optionalSecretEnv` inside a
  // subscribe.environments[] item is SILENTLY DROPPED — no error, no warning,
  // the ref simply never reaches the job. A block that looks right and does
  // nothing is worse than one that fails loudly.
  it("declares no per-environment optionalSecretEnv", () => {
    const offenders: Offender[] = [];
    for (const component of COMPONENTS) {
      for (const block of component.blocks) {
        if (block.key === "optionalSecretEnv" && block.indent > 2) {
          offenders.push({
            component: component.name,
            detail: `per-environment optionalSecretEnv (silently ignored): ${block.entries.join(", ")}`,
          });
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
