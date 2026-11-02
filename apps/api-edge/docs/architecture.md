# api-edge — architecture

A `cloudflare-worker-turbo` component: TypeScript Worker built by the turbo pipeline
from `apps/api-edge`, deployed per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `billing-worker`, `config-worker`, `events-worker`, `identity-worker`, `integrations-worker`, `membership-worker`, `metering-worker`, `notifications-worker`, `projects-worker`, `webhooks-worker` —
  in-process RPC to sibling Workers; no public hops between contexts.
- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_HYPERDRIVE_PROD`, `WIRING_CLOUDFLARE_HYPERDRIVE_STAGE`, `WIRING_CLOUDFLARE_KV_PROD`, `WIRING_CLOUDFLARE_KV_STAGE`.
- **Idempotency KV** and **Hyperdrive** (pooled Postgres) bindings come
  from the `WIRING_*` documents above — the edge is the only Worker that
  talks to the data plane directly for request idempotency and DB access
  brokering.

## Request path

Every public request enters here, is authenticated, and is routed to the
owning bounded-context Worker over its service binding. Responses never
bypass the edge.
