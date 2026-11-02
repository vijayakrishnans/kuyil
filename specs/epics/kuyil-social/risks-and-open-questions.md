# kuyil-social — risks and open questions

## KY-A — The patch only exists as a lossy PDF (RISK, mitigated)

The original branch is not on this machine or GitHub. The PDF lost line breaks and corrupted seven expressions containing `$`: a doc comment, two `whyText` strings, `encodeCursor`, `cursorClause`, `activeSubscriptions` and the test `moduleNameMapper`. `git apply` cannot use it, so the files are rebuilt by hand. The tests and the end-to-end checks are the proof, and all of them must pass again before KY1 lands.

## KY-B — Real money and the operating entity (RISK, open)

Holding balances and escrowing deposits may be regulated, and duties differ by country. The earlier analysis also flagged the UK Online Safety Act if ATOMICFLEE LTD operates Kuyil, India's IT Rules, and Section 230 for a US entity. This needs legal advice. Until then no real money enters the system, and the public site must not imply otherwise.

## KY-C — The legal floor needs a real process (RISK, open)

The queue records reports, but a queue alone does not meet legal duties. CSAM in particular needs a defined reporting route and must not be left waiting for a manual review. This must be settled before Kuyil is promoted publicly. KY5 ships the queue, and it is not sufficient for a public launch on its own.

## KY-D — Prod has no money, so deposits are off there (RESOLVED)

With required deposits and no top-up, new prod users could not reply to strangers. Free credits would make the ledger's balances meaningless, so `REPLY_DEPOSITS_ENABLED` is false in prod. The cost is that prod has no spam deposit until real money exists, so stranger-reply spam is unpriced there.

## KY-E — Baseline drift since the patch (RISK, mitigated)

The patch was written against an unknown Lumen version and reported existing failures: 12 api-edge tests, one database test file and a lint error. Before KY1, run the suite on the untouched `baseline-v32` to record what was already failing, so those failures are not attributed to Kuyil.

## KY-F — Supabase capacity and cost (RISK, mitigated)

A Lumen build provisions Supabase projects, and an earlier build hit the project limit on this account. If the build stops there, pause an unused project or raise the plan; do not delete anything without asking.

## KY-G — Own backend means no network on day one (ACCEPTED)

Nostr and AT Protocol were not chosen, so Kuyil starts with zero users. Follower export keeps the door open for a later move to a protocol.

## KY-H — The "freer" crowd problem (RISK, mitigated)

Platforms that lead with free speech attract the people who drive everyone else away. Positioning, default filters and brand-safe feeds limit this, but only real usage will show whether it works.
