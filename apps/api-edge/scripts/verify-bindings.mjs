import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// BF6: resource IDs are never committed — wrangler.jsonc is rendered from
// wrangler.template.jsonc, so this checks the rendered shape (valid 32-hex,
// stage and prod distinct), not literal account IDs.
const EXPECTED_HYPERDRIVE = {
  stage: { binding: "PLATFORM_DB" },
  prod: { binding: "PLATFORM_DB" },
};

const HYPERDRIVE_ID_PATTERN = /^[0-9a-f]{32}$/;
const seenHyperdriveIds = new Map();

const EXPECTED_KV = {
  stage: {
    binding: "IDEMPOTENCY_KV",
  },
  prod: {
    binding: "IDEMPOTENCY_KV",
  },
};

const KV_ID_PATTERN = /^[0-9a-f]{32}$/;
const KV_ID_SENTINELS = new Set([
  "0000000000000000000000000000000a",
  "0000000000000000000000000000000b",
]);

const EXPECTED_SERVICES = {
  stage: [
    {
      binding: "IDENTITY_WORKER",
      service: "identity-worker-stage",
    },
    {
      binding: "MEMBERSHIP_WORKER",
      service: "membership-worker-stage",
    },
    {
      binding: "PROJECTS_WORKER",
      service: "projects-worker-stage",
    },
  ],
  prod: [
    {
      binding: "IDENTITY_WORKER",
      service: "identity-worker-prod",
    },
    {
      binding: "MEMBERSHIP_WORKER",
      service: "membership-worker-prod",
    },
    {
      binding: "PROJECTS_WORKER",
      service: "projects-worker-prod",
    },
  ],
};

const configPath = resolve(__dirname, "../wrangler.jsonc");
const raw = readFileSync(configPath, "utf-8");
const config = JSON.parse(stripJsoncComments(raw));

let failures = 0;

for (const [envName, expected] of Object.entries(EXPECTED_HYPERDRIVE)) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  const hd = envBlock.hyperdrive?.find((h) => h.binding === expected.binding);
  if (!hd) {
    console.error(
      `FAIL: [${envName}] missing hyperdrive binding "${expected.binding}"`
    );
    failures++;
    continue;
  }

  if (typeof hd.id !== "string" || !HYPERDRIVE_ID_PATTERN.test(hd.id)) {
    console.error(
      `FAIL: [${envName}] binding "${expected.binding}" id "${hd.id}" does not match /^[0-9a-f]{32}$/`
    );
    failures++;
    continue;
  }

  seenHyperdriveIds.set(envName, hd.id);

  const envVar = envBlock.vars?.ENVIRONMENT;
  if (envVar !== envName) {
    console.error(
      `FAIL: [${envName}] ENVIRONMENT var mismatch: got "${envVar}", want "${envName}"`
    );
    failures++;
    continue;
  }

  console.log(`OK: [${envName}] PLATFORM_DB → ${hd.id}`);
}

if (
  seenHyperdriveIds.has("stage") &&
  seenHyperdriveIds.get("stage") === seenHyperdriveIds.get("prod")
) {
  console.error(
    `FAIL: stage and prod share the same Hyperdrive id "${seenHyperdriveIds.get("stage")}"`
  );
  failures++;
}

for (const [envName, expected] of Object.entries(EXPECTED_KV)) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  const kv = envBlock.kv_namespaces?.find((k) => k.binding === expected.binding);
  if (!kv) {
    console.error(
      `FAIL: [${envName}] missing kv_namespaces binding "${expected.binding}"`
    );
    failures++;
    continue;
  }

  if (typeof kv.id !== "string" || !KV_ID_PATTERN.test(kv.id)) {
    console.error(
      `FAIL: [${envName}] kv binding "${expected.binding}" id "${kv.id}" does not match /^[0-9a-f]{32}$/`
    );
    failures++;
    continue;
  }

  if (KV_ID_SENTINELS.has(kv.id)) {
    console.error(
      `FAIL: [${envName}] kv binding "${expected.binding}" still uses sentinel id "${kv.id}" — replace with the real Cloudflare KV namespace id`
    );
    failures++;
    continue;
  }

  console.log(`OK: [${envName}] ${expected.binding} → ${kv.id}`);
}

for (const [envName, expectedList] of Object.entries(EXPECTED_SERVICES)) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  for (const expected of expectedList) {
    const svc = envBlock.services?.find((s) => s.binding === expected.binding);
    if (!svc) {
      console.error(
        `FAIL: [${envName}] missing service binding "${expected.binding}"`
      );
      failures++;
      continue;
    }

    if (svc.service !== expected.service) {
      console.error(
        `FAIL: [${envName}] service binding "${expected.binding}" target mismatch: got "${svc.service}", want "${expected.service}"`
      );
      failures++;
      continue;
    }

    if (svc.service.includes("prod") && envName !== "prod") {
      console.error(
        `FAIL: [${envName}] cross-environment binding detected: "${svc.service}" bound in "${envName}"`
      );
      failures++;
      continue;
    }

    if (svc.service.includes("stage") && envName !== "stage") {
      console.error(
        `FAIL: [${envName}] cross-environment binding detected: "${svc.service}" bound in "${envName}"`
      );
      failures++;
      continue;
    }

    console.log(`OK: [${envName}] ${expected.binding} → ${svc.service}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} binding verification failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll binding verifications passed.");
}
