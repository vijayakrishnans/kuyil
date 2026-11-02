# Kuyil

`vijayakrishnans/kuyil` — a multi-tenant SaaS on Cloudflare Workers
and Supabase Postgres, run as an [Orun](https://github.com/sourceplane/orun)
component-native desired-state repo. Identity, organizations, projects, RBAC,
audit, metering, billing, webhooks and notifications are separate
bounded-context Workers behind one public edge API, with a Next.js console on
Workers + Static Assets.

## Live deployment

<!-- 08-docs:begin -->
Not recorded yet. The build's last phase writes the live URLs, the workspace
and the secrets inventory into
[ai/context/deployment.md](ai/context/deployment.md); how the product deploys
and how to operate it is in
[ai/context/operations.md](ai/context/operations.md).
<!-- 08-docs:end -->

## Working on it

Start at [AGENTS.md](AGENTS.md). It is written for a coding agent and is the
shortest way in for a person too: what to read first, how a change lands, and
what not to touch.

## What is here

| Path | What it is |
|---|---|
| `apps/api-edge` | The one public HTTP entry point; reaches the workers over service bindings |
| `apps/*-worker` | Twelve bounded-context Workers — identity, membership, projects, policy, events, config, metering, billing, notifications, webhooks, integrations, admin. Never public |
| `apps/web-console-next` | The console: Next.js on Workers + Static Assets, configured against the edge |
| `packages/*` | Shared libraries: contracts, SDK, CLI, the database harness, the policy engine, the notifications client, the webhook verifier |
| `infra/terraform/*` | The data plane: Supabase projects, Hyperdrive, the edge's idempotency KV, and the custom-domain component (parked until a domain is set) |
| `infra/db-migrate` | Database migrations — planned on pull requests, applied on merge |
| `tests/*` | Per-component contract and verifier suites |
| `intent.yaml` | The environments, the pinned composition catalog, and the Orun workspace this repository deploys into |

`stage` and `prod` are provisioned and deployed; `dev` is verify-only.

## Getting started

Node.js 20 or later and pnpm 10.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## How it deploys

Merges to `main` converge through Orun: `.github/workflows/ci.yml` runs
`orun plan --changed`, then one `orun run` lane per planned component. A pull
request plans and verifies; a push to `main` deploys `stage`, then `prod` once
`stage` has converged on the same commit. No pnpm, Wrangler or Terraform
command runs directly in CI.

The pipeline holds one credential, GitHub's own `GITHUB_TOKEN`. Cloudflare and
Supabase credentials are brokered per run from the workspace's connections;
nothing provider-shaped is stored in the repository or in GitHub.

## Custom domain

The product answers on workers.dev from its first deploy. Setting a domain is
one pull request, later:
[Setting the domain later](ai/context/operations.md#setting-the-domain-later).
