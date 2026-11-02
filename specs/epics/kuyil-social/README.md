# Epic: kuyil-social (KY)

**Creators who get throttled or demonetized do not own their audience, cannot see why their reach changed, and lose a large cut of what fans pay them. Kuyil is a short-post network where readers choose their own feeds and filters, every post can explain why it appeared, followers can be exported, and creators keep 94% of what they earn. The design idea is that hosting is neutral and curation belongs to the reader, so the platform removes only what the law requires and earns from creator payments instead of brand pressure.**

Kuyil (Malayalam for the koel, a songbird) launches as "own your audience, get paid directly, no hidden algorithm", not as "the free speech X". Its first users are creators who have been demonetized or throttled, and the readers who follow them.

## Status

| Field | Value |
|-------|-------|
| Status | Draft |
| Cluster | **KY** (KY0–KY5) |
| Owner(s) | `apps/social-worker` (the resource) · `packages/db` (`social`, `wallet`) · `apps/api-edge` (the facade) · `apps/kuyil-web` (the surface) |
| Builds on | `lumen baseline-v32` — identity, sessions, api-edge, rate limiting, audit, Hyperdrive to Supabase Postgres |
| Changes | Adds the `social` and `wallet` contexts, one worker and one public web app. The baseline's admin console stays as the operator surface. |
| Decisions locked | (1) Lumen, because the ledger needs Postgres transactions. (2) Own backend first; Nostr or AT Protocol later. (3) Play money only until a legal entity and payment provider are chosen. (4) Reply deposits are off wherever no real money can enter. |
| Gate | KY1 is API only. KY2 is the first user-visible change. |
| Shipped as | |

## Read order

1. `design.md` — the resource, the routes, the surfaces, what is out of scope
2. `implementation-plan.md` — the milestones and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| KY0 — the spec | this doc set | merged, and the epic shows its milestones |
| KY1 — social core | the patch's worker, schema and ledger, restored and renamed | `/v1/social/health` answers on stage and prod; unit and 42 end-to-end checks pass |
| KY2 — the timeline app | sign-in, handle, post, reply, thread, profile, follow | a new user signs in and posts on stage and prod in a browser |
| KY3 — your feeds and filters | feed tabs, filters, "why am I seeing this", community curations | a reader publishes a filter and a second reader subscribes to it |
| KY4 — play-money wallet | wallet, tips, subscriptions, paywalls, reply deposits, human check | every money flow works in the browser on stage, and the ledger audit returns no rows |
| KY5 — trust and exit | legal report queue, follower export, economics page, public landing page | an admin resolves a report, and a user downloads their export |
