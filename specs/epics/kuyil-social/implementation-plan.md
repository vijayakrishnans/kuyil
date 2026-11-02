# kuyil-social — implementation plan

Milestones land in order. Each is one or more tasks, each task one pull request. A milestone is marked ✅ here when its "done when" list is true, and recorded in `IMPLEMENTATION-STATUS.md`.

## KY0 — the spec ✅

This doc set, merged to `main`.

**Done when**
- the five documents are on `main`
- `task_get kuyil-social` shows the epic with its milestones

## KY1 — social core

Restore the patch from the PDF export: rebuild its line breaks and the seven expressions the PDF corrupted, rename `lumen-*` wiring to `kuyil-*`, recompute migration checksums, regenerate the lockfile. Add `REPLY_DEPOSITS_ENABLED`. Make a concurrent retry with the same idempotency key replay instead of returning a 500.

**Done when**
- `GET /v1/social/health` reports `db: true` on stage and prod
- both migrations applied on stage and prod
- the unit tests pass, and all end-to-end checks pass against a real Postgres, including money conservation
- a prod reply to a stranger succeeds with no deposit

## KY2 — the timeline app

`apps/kuyil-web`: sign-in, choose a handle, post, reply, thread, profile, follow, the Everything and Following feeds.

**Done when**
- in a browser on stage and prod, a new user signs in, picks a handle, posts and replies
- a signed-out visitor can read Everything, a thread and a profile
- it works at phone width

## KY3 — your feeds and filters ✅

Feed tabs including Hot and Brand-safe, built-in and community filters, "show anyway", "why am I seeing this", publishing curations.

**Done when**
- a filtered post collapses with its reason and opens with "show anyway"
- Hot's explanation shows that post's real numbers
- one user publishes a filter and a second user subscribes and sees it apply

## KY4 — play-money wallet ✅

Wallet, tips, creator subscriptions, subscriber-only posts, paid curations, reply deposits, human check. Clearly labelled test money, on stage only.

**Done when**
- on stage in a browser: top up, tip, subscribe, unlock a post, buy a feed, hold and settle a deposit
- the ledger audit query returns no rows
- no prod route can add money

## KY5 — trust and exit ✅

Legal report queue, follower and post export, economics page, public landing page.

**Done when**
- a report reaches the queue, an admin resolves it, and a removed post returns 404
- a user downloads an export containing their followers and posts
- the landing page leads with audience ownership

## Sequencing note

KY1 must come first because every surface calls it. KY3 and KY4 both need KY2's app but do not need each other. KY5 is last because the landing page should describe only what is live.
