#!/usr/bin/env node
// THE CONSOLE, BUILT ONCE PER BASELINE (saas-console-artifact CA3/CA4).
//
// Since CA1/CA2 the console carries no product identity and no environment in
// its build — both come from the Worker's `vars` and host at runtime — so the
// OpenNext output of a baseline commit can be deployed as any product's
// console. A bootstrap's first console deploy downloads it instead of spending
// 4-5 minutes on a cold Next.js build.
//
// Artifacts are CONTENT-ADDRESSED: named by a hash of the sources that produce
// the build (this app, packages/, the lockfile and root build config), on one
// rolling `console-artifacts` release. An artifact can only ever be used for
// exactly the code it was built from, and nothing needs to know a tag.
//
//   hash    [--root <repo>]                         print the source hash
//   pack    [--root <repo>] [--out <dir>]           bundle the built worker
//           (wrangler --dry-run) and tar it with the static assets as
//           web-console-next-<hash>.tar.gz (+ .sha256); build first
//   pin     --baseline <dir> --repo <owner/repo>    (a bootstrap hook, run in
//           [--root <product>]                      the product) if the
//           baseline's sources have a published artifact, record it and the
//           product's own source hash in console-artifact.pin.json
//   build   [--root <repo>]                         (the component's build
//           command) if a pin exists and this tree still hashes to it, fetch
//           and verify the artifact; otherwise run the normal turbo build
//
// Node + the system `tar` and `gzip`. No dependencies.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "apps/web-console-next";
const RELEASE = "console-artifacts";
const PIN = "console-artifact.pin.json";
// What decides the console's build output, relative to the repo root.
const SOURCES = [APP, "packages", "tooling/tsconfig", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", "dist", ".turbo", ".wrangler", "coverage"]);
const SKIP_FILES = new Set([`${APP}/${PIN}`]);
// Byproducts a build or typecheck writes into the source tree: hashing them
// would make the publish job (which hashes after building) disagree with a
// bootstrap (which hashes a clean clone).
const SKIP_FILE_RE = /(\.tsbuildinfo|(^|\/)next-env\.d\.ts)$/;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`✕ console-artifact: ${message}`);
  process.exit(1);
}

function repoRoot() {
  const given = arg("root");
  if (given) return path.resolve(given);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const up = path.dirname(dir);
    if (up === dir) fail("no pnpm-workspace.yaml above this script; pass --root");
    dir = up;
  }
  return dir;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** sha256 over every source file's path and content, in a fixed order. */
export function sourceHash(root) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(rel))) return;
      for (const name of fs.readdirSync(abs)) walk(rel ? `${rel}/${name}` : name);
    } else if (stat.isFile() && !SKIP_FILES.has(rel) && !SKIP_FILE_RE.test(rel)) {
      files.push(rel);
    }
  };
  for (const source of SOURCES) walk(source);
  files.sort();
  const h = createHash("sha256");
  for (const rel of files) h.update(`${rel}\0${sha256(fs.readFileSync(path.join(root, rel)))}\n`);
  return h.digest("hex").slice(0, 32);
}

const assetName = (hash) => `web-console-next-${hash}.tar.gz`;
const releaseUrl = (repo) => `https://github.com/${repo}/releases/download/${RELEASE}`;

function pack() {
  const root = repoRoot();
  const hash = sourceHash(root);
  const app = path.join(root, APP);
  for (const required of ["worker.js", "assets"]) {
    if (!fs.existsSync(path.join(app, ".open-next", required))) fail(`${APP}/.open-next/${required} is missing: build first`);
  }
  const out = path.resolve(arg("out", "dist/console-artifact"));
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "console-artifact-pack-"));
  try {
    // BUNDLE HERE, WHERE THE BUILD IS. OpenNext's output require()s files by
    // ABSOLUTE build-machine paths (/home/runner/work/<repo>/…/.open-next/…),
    // which `wrangler deploy` resolves when it bundles — so the raw
    // .open-next only deploys on the machine, at the path, that built it.
    // Bundling on this machine resolves them; the artifact is the
    // self-contained worker plus the static assets — exactly what a deploy
    // uploads — and re-bundling it in a product's deploy is a no-op.
    const wrangler = path.join(app, "node_modules", ".bin", "wrangler");
    if (!fs.existsSync(wrangler)) fail(`${wrangler} is missing: install the workspace first`);
    execFileSync(wrangler, ["deploy", "--dry-run", "--config", "wrangler.jsonc", "--outdir", path.join(work, "bundle")], {
      cwd: app,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const bundled = path.join(work, "bundle", "worker.js");
    if (!fs.existsSync(bundled)) fail("wrangler produced no bundled worker.js");
    if (/require\(\s*["']\//.test(fs.readFileSync(bundled, "utf8"))) {
      fail("the bundled worker still require()s an absolute path; it would only run on this machine");
    }
    const stage = path.join(work, "stage", ".open-next");
    fs.mkdirSync(stage, { recursive: true });
    fs.copyFileSync(bundled, path.join(stage, "worker.js"));
    fs.cpSync(path.join(app, ".open-next", "assets"), path.join(stage, "assets"), { recursive: true });

    const name = assetName(hash);
    const raw = path.join(out, name.replace(/\.gz$/, ""));
    // Deterministic: the same build packs to the same bytes.
    execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", raw, "-C", path.join(work, "stage"), ".open-next"]);
    execFileSync("gzip", ["-n", "-9", "-f", raw]);
    const tarball = path.join(out, name);
    const digest = sha256(fs.readFileSync(tarball));
    fs.writeFileSync(`${tarball}.sha256`, `${digest}  ${name}\n`);
    console.log(`✓ ${name}  ${(fs.statSync(tarball).size / 1e6).toFixed(1)} MB  sha256:${digest}`);
    console.log(`asset=${name}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function get(url) {
  if (url.startsWith("file://")) return fs.readFileSync(fileURLToPath(url));
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    const err = new Error(`GET ${url}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function pin() {
  const baseline = arg("baseline");
  const repo = arg("repo");
  if (!baseline || !repo) fail("pin needs --baseline <dir> and --repo <owner/repo>");
  const root = repoRoot();
  const name = assetName(sourceHash(path.resolve(baseline)));
  const base = arg("from", releaseUrl(repo));
  let digest;
  try {
    digest = (await get(`${base}/${name}.sha256`)).toString("utf8").trim().split(/\s+/)[0];
  } catch (err) {
    // No artifact for this baseline's sources: the product builds the console
    // itself, exactly as before. Not an error.
    console.log(`· no prebuilt console for this baseline (${err.message}); the product will build it`);
    fs.rmSync(path.join(root, APP, PIN), { force: true });
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(digest ?? "")) fail(`${name}.sha256 is not a sha256`);
  const record = { url: `${base}/${name}`, sha256: digest, sourceHash: sourceHash(root) };
  fs.writeFileSync(path.join(root, APP, PIN), JSON.stringify(record, null, 2) + "\n");
  console.log(`✓ pinned ${name} for this product's console (sources ${record.sourceHash})`);
}

function turboBuild(root) {
  execFileSync("pnpm", ["exec", "turbo", "run", "build", "--filter=@saas/web-console-next"], { cwd: root, stdio: "inherit" });
}

async function build() {
  const root = repoRoot();
  const pinFile = path.join(root, APP, PIN);
  if (!fs.existsSync(pinFile)) return turboBuild(root);
  const record = JSON.parse(fs.readFileSync(pinFile, "utf8"));
  const current = sourceHash(root);
  if (current !== record.sourceHash) {
    console.log(`· the console's sources changed since the pin (${record.sourceHash} → ${current}); building from source`);
    return turboBuild(root);
  }
  let tarball;
  try {
    tarball = await get(record.url);
  } catch (err) {
    console.log(`· ${err.message}; building from source`);
    return turboBuild(root);
  }
  const actual = sha256(tarball);
  // A digest mismatch is never papered over with a build: something served
  // bytes other than the ones that were published.
  if (actual !== record.sha256) fail(`${record.url}: sha256 ${actual}, pinned ${record.sha256}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "console-artifact-"));
  try {
    fs.writeFileSync(path.join(work, "a.tar.gz"), tarball);
    execFileSync("tar", ["-xzf", path.join(work, "a.tar.gz"), "-C", work, "--no-same-owner"]);
    if (!fs.existsSync(path.join(work, ".open-next", "worker.js"))) fail(`${record.url} holds no .open-next/worker.js`);
    const app = path.join(root, APP);
    fs.rmSync(path.join(app, ".open-next"), { recursive: true, force: true });
    fs.renameSync(path.join(work, ".open-next"), path.join(app, ".open-next"));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`✓ prebuilt console ${path.basename(record.url)} (sha256:${actual}); no build`);
}

const command = process.argv[2];
if (command === "hash") console.log(sourceHash(repoRoot()));
else if (command === "pack") pack();
else if (command === "pin") await pin();
else if (command === "build") await build();
else {
  console.error("usage: console-artifact.mjs hash|pack|pin|build [--root <repo>] …  (see the header)");
  process.exit(2);
}
