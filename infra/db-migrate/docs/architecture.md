# db-migrate — architecture

A `db-migrate` component rooted at `infra/db-migrate`.

- Connects with the job-output secrets published by the `supabase`
  terraform (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_URL`, `SUPABASE_PROJECT_REF`) —
  resolved per run, never stored in CI.
- **Plan on PRs** (what would change), **apply on merge** — the same
  convergence contract as every other component.
- Migrations are forward-only; rollbacks are new migrations.
