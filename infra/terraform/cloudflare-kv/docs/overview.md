# cloudflare-kv

Provisions Cloudflare KV namespaces backing the api-edge idempotency replay store (stage and prod)

Manages the `api-edge` idempotency KV namespace for kuyil, per environment (`stage`, `prod`; `dev` is
verify-only and provisions nothing).

## Depends on

- (none)

## Depended on by

- **api-edge** — Cloudflare Worker for the API edge Runtime
