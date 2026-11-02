# Architecture

Four Jest suites, no runtime dependencies, no network. It walks `apps/*`, reads
the first of `wrangler.template.jsonc` or `wrangler.jsonc` it finds per app,
strips line comments and the deploy-time `@@wiring(...)@@` placeholders, and
asserts over the parsed objects.

Reading the **template** rather than the rendered config is deliberate: the
template is what is committed and reviewed, and the rendered `wrangler.jsonc`
is gitignored for workers that carry resource IDs. An assertion against the
rendered file would be an assertion against a build artifact that does not
exist on a clean checkout.

The suite deliberately asserts on named lists rather than counts. A failure
that reads `["integrations-worker: * * * * *", ...]` tells the reader which
jobs are competing for the budget; a failure that reads `expected 6 to be at
most 5` does not.

## secret-scoping.test.ts

Walks `apps/*` and `infra/*` for `component.yaml`, and collects every
`secretEnv` / `optionalSecretEnv` block tagged with the indentation it was
declared at — 2 spaces means component-level (attached to every environment),
8 means inside a `subscribe.environments[]` item.

Line-oriented rather than a YAML parse, deliberately: these files are
hand-written in one consistent style, and a guard whose whole value is being
cheap enough to always run should not pull a parser in to read four keys.

The two failure shapes it encodes were both established empirically against
`orun plan`, not inferred: a component-level ref reaches every environment, and
a per-environment `optionalSecretEnv` is dropped without a warning.

## account-budget.test.ts

Computes what the fleet actually costs the Cloudflare account, rather than
checking the shape of any one config.

It derives the deployed set from `subscribe.environments[]` — the pairs whose
`profileRules` carry a `deploy` or `apply` profile — then prices each one. Cron
pricing applies wrangler's inheritance rule: a top-level `triggers` block is
charged to *every* deployed environment, which is exactly the arithmetic that
took the account to 6 against a limit of 5.

`effectiveCrons()` is exported and unit-tested against synthetic configs, so the
pricing rule is verified independently of the repo's current state. That matters:
a budget guard that mispriced inheritance would be worse than no guard, and this
way it demonstrates it can catch the regression without one being planted.

## service-chain.test.ts

Builds the service-binding graph from each worker's prod `services` block and
measures two things: the longest simple chain from every entry point, and every
distinct cycle.

Both numbers are pinned rather than merely bounded. A bound alone would let the
worst case creep from 8 to 11 without anyone noticing; pinning makes each step
a visible edit here and in the profile spec.

Cycles get their own gate because they are the shape this analysis cannot
bound: on a cyclic path the only limit is the platform's 32-invocation cap,
which is a bug's ceiling rather than a design's. The two that exist are
allowlisted, not banned — they are long-standing and the fleet works. The gate
exists so a third is deliberate.

`longestChain()` and `findCycles()` are exported and unit-tested on synthetic
graphs, so the analysis is verified independently of the fleet's current shape.
