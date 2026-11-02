# platform-limits-tests

Structural guards on the **platform contracts the whole worker fleet deploys
under**, read straight off the committed `wrangler` templates and
`component.yaml` files: Cloudflare's per-account limits, and how components
declare the secrets their jobs resolve.

These are not runtime tests. They defend limits that are per-account and only
bite at deploy time — after every other lane has gone green. The cron-trigger
ceiling is the motivating case: nothing in a worker's own config is wrong, the
arithmetic across all workers and all environments is, and the only feedback is
a failed deploy reading `This account has reached the Workers Free limit of 5
cron triggers per account`.

The budget these numbers come from is `specs/profiles/free-tier.md`.

The secret-scoping gates defend a contract the composition states itself, in
`cloudflare-worker-turbo-verify.yaml`: *"Offline fixture render only — verify
lanes must never need cloud credentials (BF6 D5 guard); wire-live is
deploy-only."* Component-level `secretEnv` bypasses that guarantee, because
orun attaches it to every job in every environment regardless of profile.

## Gates

- No worker declares `triggers` at the top level, where every named environment
  inherits it (one declaration, one trigger per deployed environment).
- Only the environment the free-tier profile deploys (`prod`) declares crons.
- A single-environment deployment stays within 5 cron triggers.
- No worker ships with `minify` disabled, against the free plan's 3MB gzip cap.
- The **service-binding chain** stays inside the fleet's depth budget, its
  worst case matches the pinned measurement, and no unreviewed cycle appears.
- The **account budget** — cron triggers, worker scripts and Hyperdrive configs
  summed across every `(component, environment)` pair a main-push convergence
  deploys — fits inside the free plan, with two cron slots held in reserve.
- No component declares a **required** `secretEnv` at component level whose ref
  hard-codes an environment — that is what makes a dev job require a prod
  credential it never reads.
- No component declares a per-environment `optionalSecretEnv`, a form orun
  silently drops.
