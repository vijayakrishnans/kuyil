# kuyil-social — design

## 1. The resource

New schemas `social` and `wallet`, migrations `200_social_core` and `210_wallet_ledger`. Public ids are `usr_`, `pst_` and `cur_` followed by 32 hex characters. Identity, sessions, rate limiting and audit are reused from Lumen.

```
social.profiles        user_id, handle, bio, sub_price_minor, verified_at
social.posts           id, author_id, body (1-500), labels[], subscribers_only, reply_to, removed_at
social.follows         follower_id, followee_id
social.curations       id, owner_id, kind (feed|filter), keywords[], labels[], price_minor
social.curation_access user_id, curation_id, transfer_id
social.user_prefs      user_id, feeds[], filters[], active_feed
social.reports         post_id, reporter_id, reason (closed legal list), status
wallet.accounts        owner_kind (user|platform|escrow|external), balance_minor
wallet.transfers       kind, actor_id, idempotency_key, refs, metadata
wallet.postings        transfer_id, account_id, amount_minor (append-only, sums to zero)
wallet.reply_deposits  post_id, payer_id, payee_id, status, expires_at
wallet.creator_subscriptions  subscriber_id, creator_id, starts_at, ends_at
```

Money is integer minor units. Postgres rejects unbalanced transfers, negative user and escrow balances, and edits to postings.

## 2. The API

All routes sit under `/v1/social`, in `apps/social-worker`, behind `api-edge`. GETs without a credential are anonymous; a bad credential is a 401; writes need a session. Envelopes are `{ data, meta }` and `{ error }`.

```
GET  /health                     GET  /economics
GET  /me                         PUT  /me/profile           PUT  /me/prefs
POST /me/verify                  GET  /me/wallet            GET  /me/export
POST /me/wallet/dev-topup        (404 in prod)
GET  /feeds/{ref}                GET  /curations            POST /curations
DELETE /curations/{cur}          POST /curations/{cur}/purchase
POST /posts                      GET  /posts/{pst}
POST /posts/{pst}/tips           POST /posts/{pst}/reports
POST /deposits/{pst}/refund      POST /deposits/{pst}/forfeit
GET  /users/{handle}             PUT|DELETE /users/{handle}/follow
POST /users/{handle}/subscribe
GET  /admin/reports              POST /admin/reports/{pst}/resolve
```

Fees: 6% on tips, subscriptions and curation sales; 20% of a forfeited deposit. Stranger replies hold ₹2 for 24 hours. A cron every 15 minutes refunds expired deposits.

New in this epic: `REPLY_DEPOSITS_ENABLED`. Prod has no way to add money, so a required deposit would stop every new user replying to anyone who does not follow them. It is `false` in prod and `true` on stage.

## 3. The surfaces

`apps/kuyil-web` is a new public app: a small Worker serving static modules, with `/v1/*` passed to `api-edge`. See `IMPLEMENTATION-STATUS.md` for why this is not Next.js.

- Home: feed tabs, composer, posts with collapsed filter verdicts ("show anyway") and "why am I seeing this"
- Thread and profile pages, readable without signing in
- Feeds and filters: browse, subscribe, publish, buy
- Wallet: balance, history, deposits awaiting you (stage only until real money exists)
- Settings: handle, bio, subscription price, follower export
- Legal queue (admins only), economics page, landing page

## 4. Events, secrets, and integrations

No new provider connection. Postgres is reached through the baseline's Hyperdrive wiring. `SOCIAL_ADMINS` is set per environment and holds user ids only.

## 5. Out of scope

Real money in or out (UPI, Razorpay, Stripe, Lightning), ads, a paid developer API, media uploads, DMs, Nostr or AT Protocol federation, and native apps. Each needs its own epic. Real money also needs the legal decisions in KY-B.
