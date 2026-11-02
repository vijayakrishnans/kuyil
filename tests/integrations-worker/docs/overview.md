# integrations-worker-tests

Verification suite for `integrations-worker`.

A verify-only component: its lane runs this suite against `integrations-worker` on every
plan that includes it. Nothing deploys from here — a red lane blocks the
convergence, which is the point.

> **This suite does not run in CI today.** The component subscribes to `dev`
> with the `quick-check` profile, which runs setup, install and a
> package-structure check — and no tests. See
> [docs/components/REVIEW.md](../../../docs/components/REVIEW.md); the fix is
> one word (`verify`) and belongs in a change that can watch what it turns on.

## Gates

- `pnpm exec turbo run build --filter=./` — build
- `pnpm exec turbo run typecheck --filter=./` — typecheck
- `pnpm exec turbo run test --filter=./` — the suite itself
