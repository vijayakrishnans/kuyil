# kuyil-social (KY) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| KY0 — the spec | ✅ Done | #9 |
| KY1 — social core | Live on stage and prod; prod's no-deposit reply is not yet exercised | #10, #11, #12 |
| KY2 — the timeline app | Done on stage; **open on prod** because prod has no working sign-in | #13 |
| KY3 — your feeds and filters | ✅ Done on stage | #14 |
| KY4 — play-money wallet | ✅ Done on stage; money UI hidden in prod | #15 |
| KY5 — trust and exit | ✅ Done on stage; prod has no admin yet | #16 |

## What was verified

- Locally: typecheck, 20 social-worker tests, 580 database tests, 403 api-edge tests, and 45 end-to-end checks against Postgres 17.
- On the deployed stage app, in Chromium: 15 timeline checks, 21 feed, wallet and trust checks, and 4 legal-queue checks. One timeline run errored with a message that was not kept; the next three runs passed.
- On prod: the API and app answer, a signed-out visitor can read, money UI and the human-check filter are hidden, and `dev-topup` refuses an anonymous caller.

## Not verified

- Anything signed in on prod, including a reply to a stranger with deposits off. That path passed end to end locally only.
- The ledger audit query on the deployed stage database. Money conservation passed locally, and the balances seen in the browser on stage were right.

## What is open

1. **Prod sign-in.** Prod sends codes by email, but no mail domain is verified, and no OAuth app has secrets, so nobody can sign in. Do not set `DEBUG_DELIVERY` in prod: it returns sign-in codes to anyone who asks.
2. **Prod admin.** `SOCIAL_ADMINS` is empty in prod until the owner has an account there. Until then nobody can work the legal queue.
3. **KY-B and KY-C** in the risks file, before any public launch.

## Departures from the design

### kuyil-web is not Next.js

`design.md` said the app would use the baseline's Next.js stack. It is a small Worker serving static modules, with `/v1/*` passed to `api-edge` over a service binding. One origin needs no CORS or OAuth origin change, the content security policy can be strict, and there is no build step.

### The patch needed more than a rename

- `social-worker`'s `component.yaml` needed `preDeployCommand` (#11).
- `api-edge` needed a redeploy marker, because CI deploys only changed components (#12).
- `tests/social-worker/integration/e2e.ts` has 45 checks: the patch's file had 41, not the 42 it claimed, and this epic added 4.

### Added to the app

- "Verified humans only" is hidden in prod, where nobody can pay for the check.
- Paid curations can only be published outside prod through the app. The API doesn't enforce this.

### Stage test admin

Stage's `SOCIAL_ADMINS` holds a test account, `kuyil-stage-admin@example.com`. Stage sign-in codes are public, so anyone can sign in as it. Stage holds test data only.
