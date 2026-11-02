# social-worker architecture

```
client ─▶ api-edge (session → x-actor-subject-id, rate family "social", idempotency)
            └─▶ social-worker
                  router.ts   route table, actor parse, error mapping, per-request DB client
                  handlers.ts request validation, transactions, presentation (paywall, filter verdicts, why)
                  feed.ts     pure policy: built-ins, filter matching, Hot formula, brand-safe, explanations
                  └─▶ @saas/db/social  (SQL: profiles, posts, follows, curations, prefs, reports)
                  └─▶ @saas/db/wallet  (SQL: postTransfer + tip / subscribe / purchase / verify / deposits)
                        Postgres via Hyperdrive (PLATFORM_DB)
```

Money is integer minor units (paise). `postTransfer` writes debits before
credits, so an overdraft fails fast. A retried request with the same
`Idempotency-Key` returns the first transfer.
