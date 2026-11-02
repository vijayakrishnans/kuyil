#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../manifest.js";
import { runMigrations } from "./runner.js";
import { loadSecretFromEnv } from "./secrets.js";
import { SupabaseApiAdapter } from "./supabase-api-adapter.js";
import type { MigrationAdapter, RunMode } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

const SUPABASE_ACCESS_TOKEN = process.env["SUPABASE_ACCESS_TOKEN"];

function usage(): never {
  process.stderr.write(
    `Usage: db-migrate <plan|apply> --env <stage|prod> [--connection-uri <uri>]\n` +
    `\n` +
    `Modes:\n` +
    `  plan   — report pending migrations without mutating the database\n` +
    `  apply  — apply pending migrations\n` +
    `\n` +
    `Options:\n` +
    `  --env <stage|prod>       target environment (required)\n` +
    `\n` +
    `Environment:\n` +
    `  SUPABASE_ACCESS_TOKEN    Supabase management API token (required for apply)\n` +
    `  SUPABASE_PROJECT_REF     Supabase project ref (required for apply; wired from orun secrets)\n`,
  );
  process.exit(1);
}

interface ParsedArgs {
  mode: RunMode;
  env: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  const mode = args[0] as RunMode | undefined;
  if (mode !== "plan" && mode !== "apply") {
    usage();
  }

  let env: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = args[++i];
    }
  }

  if (!env) {
    const envFromEnv = process.env["MIGRATION_ENV"];
    if (envFromEnv) {
      env = envFromEnv;
    }
  }

  if (!env || !["stage", "prod"].includes(env)) {
    process.stderr.write("Error: --env must be 'stage' or 'prod'\n");
    process.exit(1);
  }

  return { mode, env };
}

async function resolveAdapter(
  mode: RunMode,
  env: string,
): Promise<MigrationAdapter | null> {
  if (mode === "plan") {
    return null;
  }

  if (!SUPABASE_ACCESS_TOKEN) {
    throw new Error("SUPABASE_ACCESS_TOKEN is required for apply mode");
  }

  process.stderr.write(`Loading credentials from the wired environment (orun secrets)\n`);
  const secret = loadSecretFromEnv();

  return new SupabaseApiAdapter(secret.project_ref, SUPABASE_ACCESS_TOKEN);
}

async function main(): Promise<void> {
  const { mode, env } = parseArgs(process.argv);

  process.stderr.write(`db-migrate: mode=${mode} env=${env}\n`);

  const adapter = await resolveAdapter(mode, env);

  const result = await runMigrations(manifest, {
    mode,
    migrationsDir: MIGRATIONS_DIR,
    adapter,
  });

  if (result.failed) {
    process.stderr.write(
      `FAILED: migration ${result.failed.id} — ${result.failed.error}\n`,
    );
    process.exit(1);
  }

  const output = {
    mode,
    env,
    applied: result.applied,
    skipped: result.skipped,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`db-migrate: fatal error — ${message}\n`);
  process.exit(1);
});
