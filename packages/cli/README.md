# `@saas/cli`

`kuyil` — first-class TypeScript CLI for the Kuyil control
plane. Wraps `@saas/sdk` (the only transport allowed) and surfaces a
small set of read-only commands today; write commands land in Task 0101.

## Install (workspace)

This package is internal to the `kuyil` monorepo and is not
published. Build the binary with:

```sh
pnpm --filter @saas/cli build
node packages/cli/dist/cli.js --help
```

## Commands

Auth (Task 0100):

```
kuyil login    [--api-url=URL] [--token=BEARER]
kuyil logout
kuyil whoami
```

Reads (Task 0100):

```
kuyil org list
kuyil org use <org-id>
kuyil org members
kuyil project list
```

Writes (Task 0101):

```
kuyil org invite <email> [--role=ROLE] [--idempotency-key=KEY] [--org=ORG_ID]
kuyil project create <name> [--idempotency-key=KEY]
kuyil env create <project-id> <name> [--idempotency-key=KEY]
kuyil api-key create <name> [--scope=SCOPE] [--idempotency-key=KEY]
kuyil webhook create <url> [--event=EVENT[,EVENT2,...]] [--idempotency-key=KEY]
```

Cross-resource reads (Task 0101):

```
kuyil usage summary    [--metric=METRIC] [--from=ISO] [--to=ISO]
kuyil billing summary
kuyil audit list       [--limit=N] [--cursor=CURSOR] [--category=CAT] [--all]
```

All commands accept `--output=human|json`. JSON mode emits one document
per invocation; on error, `{ "error": { "code", "message", "requestId? } }`.

### Exit codes (`src/errors.ts`)

| Code | Meaning |
|------|---------|
| 0    | Success |
| 1    | Generic / unexpected error |
| 2    | Usage error (missing/invalid args or flags) |
| 3    | Not authenticated (no stored credential) |
| 4    | API error (4xx/5xx surfaced from the SDK) |
| 5    | No active organization context |
| 6    | Idempotency replay rejected by api-edge |

### Idempotency

`--idempotency-key=KEY` is forwarded **verbatim** to the API on every
write — Stripe parity. The CLI never auto-generates a key. When you omit
the flag, no `Idempotency-Key` header is sent and the api-edge worker
falls through without replay protection (still safe for read-after-write
flows; required for retry-safe writes).

For `webhook create --event=A,B`, each child subscription gets a
deterministic suffixed key (`KEY:sub:0`, `KEY:sub:1`, …) so the whole
command remains retry-safe under partial failure.

### Active organization

Most write/cross-read commands resolve the org from the persisted
context (`kuyil org use <org-id>`). Only `org invite` accepts an
explicit `--org=ORG_ID` override; the others throw "no active
organization" (exit 5) when context is unset.

### Audit pagination

`audit list` without flags returns the first page; `--all` walks every
page until the server returns `cursor: null`. In `--all --output=json`
mode the CLI emits one JSON document per page (JSON Lines) so a
downstream pipeline can stream without buffering.

## Auth

The shipped V1 is **token-paste**: `kuyil login` prompts for a
Bearer token, validates it via `client.organizations.list()`, and stores
it. Switching to a device-flow grant once api-edge ships
`/v1/auth/device/{start,poll}` is a one-line dispatch in
`src/auth/login.ts`.

Token storage:
- `KeychainTokenStore` (preferred): macOS Keychain / Windows Credential
  Vault / Secret Service via `keytar` (lazy import; in
  `optionalDependencies`).
- `FileTokenStore` fallback: `~/.config/kuyil/credentials.json`,
  mode **0600**, parent directory mode **0700**.

Active organization context lives at
`~/.config/kuyil/config.json` (mode 0644, not a secret). Override
both via `KUYIL_CONFIG_DIR` (used by tests).

## Output stability

JSON output is deterministic given a deterministic SDK response. The CLI
adds **no** timestamps to JSON envelopes. `formatOutput()` is the only
emission path and is fully covered by tests.

## Hazards / constraints

- Zero hazards under `packages/cli/**`. The hazard set is the same as
  the rest of the monorepo: disabled-eslint comments, ts-ignore,
  ts-expect-error, and force-cast escape hatches via `as` chains.
- The package index (`src/index.ts`) is loadable in non-Node hosts; the
  keychain adapter dynamic-imports `keytar` only when needed.
- Idempotency-Key is **caller-owned**. Task 0101 wires `--idempotency-key`
  through to the SDK; the CLI never auto-mints a key.

## Testing

```sh
pnpm --filter @saas/cli typecheck
pnpm --filter @saas/cli lint
pnpm --filter @saas/cli test
pnpm --filter @saas/cli build
```

## Related

- `specs/components/13-cli-and-sdk.md` — surface contract.
- `packages/sdk` — the only allowed transport.
- Task 0101 — write commands + remaining read-only fan-out.
