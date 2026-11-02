# notifications-client

Best-effort internal client for `notifications-worker`, posting the V1 enqueue contract over its service binding.

A shared package of the kuyil workspace, consumed by the components
below at build time.

## Depended on by

- **identity-worker** — Cloudflare Worker for the Identity auth runtime
- **membership-worker** — Cloudflare Worker for the Membership org runtime
- **notifications-client-tests**
