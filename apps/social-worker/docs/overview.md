# social-worker

Kuyil, a freer X clone, runs on this baseline. This worker serves `/v1/social/**`,
reached only through `api-edge` (reads are public, writes need a session).

It owns two bounded contexts in one service, deliberately:

- **social**: profiles, posts and replies, the follow graph, curations
  (community feeds and filters), per-user preferences, and the legal-only report queue.
- **wallet**: a double-entry ledger. Tips, creator subscriptions, paid curations,
  the ₹1 human check, and refundable reply deposits all post balanced transfers.

They share a service because a reply and the deposit it holds, or a purchase and
the access it grants, must commit in one Postgres transaction.

## The promises the code keeps

| Promise | Where it's enforced |
|---|---|
| Readers choose their own filters | `feed.ts` `hiddenBy`, which returns a verdict and never deletes |
| Ranking is public | `feed.ts` `hotScore` / `whyText`, unit-tested against the published formula |
| Spam costs money | `createPost` holds a ₹2 deposit when the parent's author doesn't follow you |
| Paywalls are real | `present()` never returns a locked body |
| Money can't be invented or overdrawn | `210_wallet_ledger` triggers and CHECKs |
| Only illegal content is removed | `reports.reason` is a closed list; `/admin/*` needs `SOCIAL_ADMINS` |
| Your audience is portable | `GET /v1/social/me/export` |

The cron (`*/15 * * * *`) refunds deposits nobody settled within 24 hours.
