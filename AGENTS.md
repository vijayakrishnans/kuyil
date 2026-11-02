# AGENTS.md — Kuyil

You are working in `vijayakrishnans/kuyil`, a multi-tenant SaaS on
Cloudflare Workers and Supabase Postgres. It is an Orun desired-state repo:
every directory with a `component.yaml` is a component, and merging to `main`
is what deploys it.

## Read first, in this order

1. [`ai/context/operations.md`](ai/context/operations.md) — the operating
   contract: how a merge deploys, the secrets model, how to verify, common
   operations.
2. [`ai/context/deployment.md`](ai/context/deployment.md) — this product's
   live facts: URLs, workspace, secrets by name. Generated, so it is only as
   current as its last refresh.
3. [`intent.yaml`](intent.yaml) — the environments (`dev` verify-only,
   `stage`, then `prod`), the pinned composition catalog, the workspace.
4. `apps/api-edge/docs/` — the one public entry point and how it routes to
   the workers. Every app has the same three pages: overview, architecture,
   runbook.
5. `apps/web-console-next/docs/` — the console.

## Layout

- `apps/api-edge` is public; the twelve `apps/*-worker` are reached only
  through it, over service bindings.
- `apps/web-console-next` — Next.js on Workers + Static Assets.
- `packages/*` — contracts, SDK, CLI, database harness, policy engine.
- `infra/terraform/*` — Supabase, Hyperdrive, KV; `infra/db-migrate` — the
  schema migrations.
- `tests/*` — one suite per component.

## How a change lands

- One task, one branch, one pull request into `main`.
- Locally: `pnpm install`, then `pnpm typecheck`, `pnpm lint`, `pnpm test`
  and `pnpm build`.
- `orun plan --changed --intent intent.yaml` lists the component lanes your
  change plans — what CI will run. A change that touches no component plans
  nothing and deploys nothing.
- The pull request's CI plans and verifies. Merging deploys `stage`, then
  `prod`. A green run is not proof: check the URLs and the published wiring
  the way `operations.md` shows.
- A new component is a directory under `apps/`, `packages/`, `infra/` or
  `tests/` with a `component.yaml`; Orun discovers it on the next plan.
- Secrets are never committed. Provider credentials are brokered per run;
  runtime secrets are set with `orun secrets set`.

## Do not touch

- `execution.state` in `intent.yaml` (`workspace`, `backendUrl`,
  `requireOrg`): CI's credential-free sign-in depends on it.
- `.rebrand/values.json` — this product's identity record; the docs refresh
  reads it.
- `ai/context/deployment.md`, and the README between the `08-docs` markers:
  both are regenerated, and hand edits are overwritten.
- `.github/workflows/ci.yml` beyond its version pins. CI runs `orun plan` and
  `orun run`, never pnpm, Wrangler or Terraform directly.
- `pnpm-lock.yaml` by hand — run `pnpm install`.
- A worker's `wrangler.jsonc` where a `wrangler.template.jsonc` sits beside
  it: edit the template; the render is gitignored.
- The service bindings between billing, membership, notifications and events
  form a loop that deploys in two passes on a fresh account. The loop is
  pinned in `tests/config-worker/src/deployment-config.test.ts`; do not grow
  it.
