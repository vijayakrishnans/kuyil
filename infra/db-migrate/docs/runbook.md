# db-migrate — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence
run is the deployment; the DAG orders this component after everything it
depends on. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the
repo is the source of truth.

## Verify

The migrate lane's apply log lists executed migrations per environment.
Schema-dependent behavior is exercised by the worker verify lanes that
run in the same convergence.

## Common failures

- **Missing `SUPABASE_*` secrets**: the `supabase` terraform lane has not
  applied in this convergence — check it first.
- **A failed migration**: fix forward with a new migration; never edit an
  applied one (applied history is immutable).
