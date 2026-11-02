# supabase

Provisions Supabase projects for stage and prod and wires credentials into orun secrets

Manages the Supabase projects (`stage`, `prod`) — the product's Postgres data plane for kuyil, per environment (`stage`, `prod`; `dev` is
verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **cloudflare-hyperdrive** — Provisions Cloudflare Hyperdrive resources for stage and prod Supabase Postgres databases
- **db-migrate** — Applies database migrations to stage and prod Supabase instances
