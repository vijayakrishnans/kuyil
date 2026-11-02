# contracts

The wire contracts every worker and the console share: request and response shapes, error envelopes, and the ids they are keyed on.

A shared package of the kuyil workspace, consumed by the components
below at build time.

## Depended on by

- **admin-worker** — Internal Cloudflare Worker for audited support/administration diagnostics
- **admin-worker-tests**
- **api-edge** — Cloudflare Worker for the API edge Runtime
- **api-edge-tests**
- **billing-worker** — Cloudflare Worker for the Billing API surface (private, service-binding only)
- **billing-worker-tests**
- **config-worker** — Cloudflare Worker for the Config read-only API surface
- **config-worker-tests**
- **contracts-tests**
- **events-worker** — Cloudflare Worker for the Events and Audit runtime
- **identity-worker** — Cloudflare Worker for the Identity auth runtime
- **identity-worker-tests**
- **integrations-worker** — Cloudflare Worker for the integrations bounded context — provider connections (GitHub App first), inbound delivery inbox, repo links, and the installation-token broker
- **integrations-worker-tests**
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **membership-worker-tests**
- **metering-worker** — Cloudflare Worker for the Metering API surface (usage recording, quota checks)
- **metering-worker-tests**
- **notifications-client**
- **notifications-client-tests**
- **notifications-worker** — Cloudflare Worker for the Notifications bounded context
- **notifications-worker-tests**
- **policy-engine**
- **policy-engine-tests**
- **policy-worker** — Cloudflare Worker for policy authorization decisions
- **policy-worker-tests**
- **projects-worker** — Cloudflare Worker for the Projects runtime
- **projects-worker-tests**
- **sdk** — Runtime-agnostic TypeScript SDK for the Kuyil control plane API
- **testing**
- **web-console-next** — Next.js 15 + opennextjs/cloudflare delivery of the Kuyil web console (per-environment, Workers + Static Assets)
- **web-console-next-tests**
- **webhooks-worker** — Cloudflare Worker for webhook endpoint, subscription, and delivery-attempt management
