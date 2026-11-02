# cloudflare-hyperdrive

Provisions Cloudflare Hyperdrive resources for stage and prod Supabase Postgres databases

Manages the Hyperdrive configuration pooling Postgres for the Workers for kuyil, per environment (`stage`, `prod`; `dev` is
verify-only and provisions nothing).

## Depends on

- **supabase** — Provisions Supabase projects for stage and prod and wires credentials into orun secrets

## Depended on by

- **admin-worker** — Internal Cloudflare Worker for audited support/administration diagnostics
- **api-edge** — Cloudflare Worker for the API edge Runtime
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
