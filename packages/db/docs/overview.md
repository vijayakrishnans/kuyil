# db

Postgres access for the fleet — branded ids, the typed query layer, and the repositories each bounded context reads through.

A shared package of the kuyil workspace, consumed by the components
below at build time.

## Depended on by

- **admin-worker** — Internal Cloudflare Worker for audited support/administration diagnostics
- **admin-worker-tests**
- **api-edge** — Cloudflare Worker for the API edge Runtime
- **billing-worker** — Cloudflare Worker for the Billing API surface (private, service-binding only)
- **config-worker** — Cloudflare Worker for the Config read-only API surface
- **db-migrate** — Applies database migrations to stage and prod Supabase instances
- **db-tests**
- **events-worker** — Cloudflare Worker for the Events and Audit runtime
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
- **identity-worker-tests**
- **integrations-worker** — Cloudflare Worker for the integrations bounded context — provider connections (GitHub App first), inbound delivery inbox, repo links, and the installation-token broker
- **integrations-worker-tests**
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **membership-worker-tests**
- **metering-worker** — Cloudflare Worker for the Metering API surface (usage recording, quota checks)
- **notifications-worker** — Cloudflare Worker for the Notifications bounded context
- **notifications-worker-tests**
- **projects-worker** — Cloudflare Worker for the Projects runtime
- **testing**
- **webhooks-worker** — Cloudflare Worker for webhook endpoint, subscription, and delivery-attempt management
