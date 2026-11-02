# social-worker tests

Unit tests for the parts of Kuyil users are promised in writing: the built-in
filters, the published Hot formula, the brand-safe rule, "why am I seeing
this?", and the wallet's integer money math (fees, balanced transfers).
They run without a database; the ledger's SQL guarantees (balanced transfers,
no overdraft, append-only postings) are enforced by Postgres itself in
`packages/db/src/migrations/210_wallet_ledger`.
