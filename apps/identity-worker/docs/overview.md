# identity-worker

Cloudflare Worker for the Identity auth runtime

Part of the kuyil runtime: a Cloudflare Worker deployed per
environment (`stage`, `prod`; `dev` is verify-only). Not publicly routable — reached only through `api-edge` service bindings.

## Depends on

- **cloudflare-hyperdrive** — Provisions Cloudflare Hyperdrive resources for stage and prod Supabase Postgres databases
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **notifications-worker** — Cloudflare Worker for the Notifications bounded context
- **policy-worker** — Cloudflare Worker for policy authorization decisions

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
