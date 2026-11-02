# Runbook

```sh
pnpm --filter @saas/platform-limits-tests test
```

## A gate went red

**"declares no crons at the top level of any worker"** — a `triggers` block was
added at the root of a wrangler template. Wrangler inherits it into every named
environment, so it costs one trigger per deployed environment rather than one
overall. Move it inside the environment that needs it.

**"declares crons only in the environment the free-tier profile deploys"** — a
non-prod environment took a cron slot. The free-tier profile budgets crons for
one environment; see `specs/profiles/free-tier.md` for what a second
environment costs and which slots are still spare.

**"keeps a single-environment deployment inside the free plan's 5"** — a new
scheduled job would put the account over the free-plan ceiling. Either fold the
work into an existing tick (gate it on the minute inside the handler), or move
the job to a Durable Object alarm, which costs no cron trigger. Spending the
spare slots is a decision to record in the profile spec, not a test to relax.

**"minifies every worker that opts into the setting"** — a worker set `minify`
to false. The free plan caps a worker at 3MB gzipped against 10MB on paid.

**"declares no component-level required secret that hard-codes an
environment"** — a `secretEnv` entry under `spec:` points at a literal
`/dev/`, `/stage/` or `/prod/` rung. orun attaches component-level `secretEnv`
to every job of the component, in every environment, as a required reference,
so this makes jobs resolve credentials they never read — and resolution runs
*before* the first step, so a missing value kills the lane with `Secret not
found` and nothing built. Two fixes, depending on what the secret is:

- The job needs *its own* environment's value → template it:
  `secret://<ws>/<project>/{{ .environment }}/<KEY>`.
- Only some environments need it (a deploy-time wiring document, say) → declare
  it per-environment under `subscribe.environments[]`, on those environments
  only. This is what the twelve worker components do for
  `WIRING_CLOUDFLARE_HYPERDRIVE`.

**"declares no per-environment optionalSecretEnv"** — an `optionalSecretEnv`
block inside a `subscribe.environments[]` item. orun **silently drops** it: no
error, no warning, the reference never reaches the job. Either move it to
component level (where the optional form works, for every environment) or make
it a per-environment `secretEnv` if it is genuinely required there.

**"spends exactly the budget the profile documents"** — the set of cron
triggers the account will attach has changed. The diff names the additions. If
a new charge appeared for an environment you did not expect, the usual cause is
a top-level `triggers` block, which wrangler inherits into every deployed
environment. If the change is intended, update the expected list here and the
table in `specs/profiles/free-tier.md` together.

**"stays inside the account limit, with the reserved slots intact"** — a fourth
cron trigger. Two slots are held back deliberately; spending one is a decision
about a shared account resource, so lower `RESERVED_CRON_SLOTS` and record why
in the profile spec. Before spending one, check the alternatives the spec
lists: folding the work into an existing tick costs nothing, and a Durable
Object alarm costs no trigger at all.

**"has not deepened since it was last measured"** — a new service binding
lengthened the worst-case chain. Every hop is one more worker sharing the
request's CPU budget (a single 10ms budget on the free plan) plus a
serialize/parse round trip. Check whether the caller genuinely needs a new
bounded context or whether the data is already reachable on the current path.
If the depth is intended, update `DEEPEST` and the figure in
`specs/profiles/free-tier.md` together.

**"contains only the cycles that have been reviewed"** — a new cycle in the
binding graph. A cycle makes the chain unbounded to static analysis: nothing
stops a request looping except the platform's 32-invocation cap. Prefer
breaking it — usually one direction is a notification or an event emit that
could go through the event log instead of a direct binding. If it has to stay,
add it to `ACCEPTED_CYCLES` with the reasoning in the commit message.
