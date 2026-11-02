// Run against a THROWAWAY Postgres with 200_social_core and 210_wallet_ledger applied:
//   KUYIL_E2E_DATABASE_URL=postgres://… npx tsx tests/social-worker/integration/e2e.ts
// Drives the real router + cron entrypoint: 45 checks incl. money conservation.
// End-to-end: drive social-worker's real router against local Postgres.
import worker from "../../../apps/social-worker/src/index.js";
import { route } from "../../../apps/social-worker/src/router.js";

const env: any = { REPLY_DEPOSITS_ENABLED: "true", ENVIRONMENT: "stage", PLATFORM_DB: { connectionString: process.env.KUYIL_E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/postgres" }, SOCIAL_ADMINS: "" };
const usr = (n: number) => "usr_" + n.toString(16).padStart(32, "0");
const ANU = usr(1), MARCUS = usr(2), MOON = usr(3), ADMIN = usr(9);
env.SOCIAL_ADMINS = ADMIN;
let fails = 0;
function check(name: string, cond: boolean, extra?: unknown) { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) { fails++; if (extra !== undefined) console.log(" ", JSON.stringify(extra).slice(0, 400)); } }
async function call(method: string, path: string, as: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (as) { h["x-actor-subject-id"] = as; h["x-actor-subject-type"] = "user"; }
  const res = await route(new Request("https://social.internal" + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const j: any = await res.json();
  return { status: res.status, ...j };
}

(async () => {
  // onboarding
  check("post before profile needs a handle", (await call("POST", "/v1/social/posts", ANU, { body: "hi" })).status === 409);
  for (const [u, h] of [[ANU, "anu"], [MARCUS, "marcus"], [MOON, "moonboy"], [ADMIN, "kuyiladmin"]]) await call("PUT", "/v1/social/me/profile", u, { handle: h, bio: "", subPriceMinor: 400 });
  check("duplicate handle refused", (await call("PUT", "/v1/social/me/profile", MOON, { handle: "anu" })).status === 409);
  check("bad handle refused", (await call("PUT", "/v1/social/me/profile", MOON, { handle: "A!" })).status === 422);
  for (const u of [ANU, MARCUS, MOON]) await call("POST", "/v1/social/me/wallet/dev-topup", u, { amountMinor: 10000 });
  const me = await call("GET", "/v1/social/me", ANU);
  check("me shows ₹100 after dev top-up", me.data.balanceMinor === 10000, me);

  // posting
  const p1 = await call("POST", "/v1/social/posts", MARCUS, { body: "Shipped my indie game demo", labels: [] });
  check("marcus posts", p1.status === 201, p1);
  const paid = await call("POST", "/v1/social/posts", ANU, { body: "Chapter 9: the ferry from Vypin…", subscribersOnly: true });
  const pol = await call("POST", "/v1/social/posts", ANU, { body: "Council voted 7–4", labels: ["politics", "notalabel"] });
  check("unknown labels dropped", JSON.stringify(pol.data.post.labels) === '["politics"]', pol);
  await call("POST", "/v1/social/posts", MOON, { body: "$KOEL airdrop 100x", labels: ["crypto"] });
  await call("POST", "/v1/social/posts", MARCUS, { body: "nsfw thing", labels: ["nsfw"] });

  // anonymous read: everything feed, paywall enforced, nsfw hidden by default
  const anon = await call("GET", "/v1/social/feeds/latest", null);
  check("anonymous can read Everything", anon.status === 200 && anon.data.posts.length === 5, anon);
  const lockedPost = anon.data.posts.find((p: any) => p.id === paid.data.post.id);
  check("paywalled body never leaves the worker", lockedPost.locked === true && lockedPost.body === null, lockedPost);
  check("nsfw hidden by default filter (but returned with a verdict)", anon.data.posts.find((p: any) => p.labels.includes("nsfw")).hidden?.id === "f_nsfw");
  check("anonymous can't read Following", (await call("GET", "/v1/social/feeds/following", null)).status === 401);

  // reply deposits
  const r1 = await call("POST", "/v1/social/posts", MOON, { body: "bro check my airdrop", replyTo: p1.data.post.id });
  check("stranger reply holds ₹2", r1.status === 201 && r1.data.depositMinor === 200, r1);
  await call("PUT", "/v1/social/users/anu/follow", MARCUS);
  const r2 = await call("POST", "/v1/social/posts", ANU, { body: "nice demo!", replyTo: p1.data.post.id });
  check("reply from someone the author follows is free", r2.data.depositMinor === 0, r2);
  const w = await call("GET", "/v1/social/me/wallet", MARCUS);
  check("marcus sees one deposit awaiting him", w.data.depositsAwaitingYou.length === 1, w.data);
  check("only the recipient can settle", (await call("POST", `/v1/social/deposits/${r1.data.post.id}/forfeit`, ANU)).status === 403);
  const f = await call("POST", `/v1/social/deposits/${r1.data.post.id}/forfeit`, MARCUS);
  check("recipient flags spam", f.status === 200 && f.data.status === "forfeited", f);
  check("can't settle twice", (await call("POST", `/v1/social/deposits/${r1.data.post.id}/refund`, MARCUS)).status === 409);

  // deposits switched off (prod today): a stranger replies free, and is told so
  env.REPLY_DEPOSITS_ENABLED = "false";
  const r0 = await call("POST", "/v1/social/posts", MOON, { body: "free reply", replyTo: pol.data.post.id });
  check("deposits off: stranger reply holds nothing", r0.status === 201 && r0.data.depositMinor === 0, r0);
  check("deposits off: thread asks for no deposit", (await call("GET", `/v1/social/posts/${pol.data.post.id}`, MOON)).data.replyDepositMinor === 0);
  env.REPLY_DEPOSITS_ENABLED = "true";

  // tips + idempotency
  const t1 = await call("POST", `/v1/social/posts/${p1.data.post.id}/tips`, ANU, { amountMinor: 500 }, { "idempotency-key": "tip-1" });
  const t2 = await call("POST", `/v1/social/posts/${p1.data.post.id}/tips`, ANU, { amountMinor: 500 }, { "idempotency-key": "tip-1" });
  check("tip: creator nets 94%", t1.status === 201 && t1.data.creatorNetMinor === 470, t1);
  check("retried tip with same key is not charged twice", t2.status === 200 && t2.data.replayed === true, t2);
  check("tip more than you have → 402", (await call("POST", `/v1/social/posts/${p1.data.post.id}/tips`, MOON, { amountMinor: 999999 })).status === 402);
  check("can't tip yourself", (await call("POST", `/v1/social/posts/${p1.data.post.id}/tips`, MARCUS, { amountMinor: 100 })).status === 403);

  // subscriptions unlock paywall
  const s = await call("POST", "/v1/social/users/anu/subscribe", MARCUS);
  check("subscribe charges anu's price", s.status === 201 && s.data.priceMinor === 400, s);
  const th = await call("GET", `/v1/social/posts/${paid.data.post.id}`, MARCUS);
  check("subscriber reads the paywalled chapter", th.data.post.locked === false && th.data.post.body.startsWith("Chapter 9"), th.data.post);

  // curations
  const feed = await call("POST", "/v1/social/curations", ANU, { kind: "feed", name: "Kerala Lit", keywords: "chapter, vypin", priceMinor: 300 });
  check("paid feed created", feed.status === 201, feed);
  check("paid feed locked before purchase", (await call("GET", `/v1/social/feeds/${feed.data.id}`, MARCUS)).status === 402);
  const buy = await call("POST", `/v1/social/curations/${feed.data.id}/purchase`, MARCUS);
  check("purchase unlocks", buy.status === 201 && buy.data.chargedMinor === 300, buy);
  const kl = await call("GET", `/v1/social/feeds/${feed.data.id}`, MARCUS);
  check("community feed matches + explains why", kl.status === 200 && kl.data.posts.length === 1 && /Kerala Lit/.test(kl.data.posts[0].why), kl.data);
  const flt = await call("POST", "/v1/social/curations", MARCUS, { kind: "filter", name: "No moonboy", keywords: ["@moonboy"] });
  await call("PUT", "/v1/social/me/prefs", MARCUS, { feeds: ["latest", "hot"], filters: ["f_nsfw", flt.data.id], activeFeed: "latest" });
  const mf = await call("GET", "/v1/social/feeds/latest", MARCUS);
  check("community filter hides @moonboy for marcus", mf.data.posts.find((p: any) => p.author.handle === "moonboy").hidden?.name === "No moonboy", mf.data.posts.map((p: any) => p.hidden));
  const hot = await call("GET", "/v1/social/feeds/hot", ANU);
  check("Hot puts the tipped+replied post first", hot.data.posts[0].id === p1.data.post.id && /Score/.test(hot.data.posts[0].why), hot.data.posts.map((p: any) => [p.author.handle, p.why]));
  const bs = await call("GET", "/v1/social/feeds/brandsafe", ANU);
  check("brand-safe excludes labelled + paywalled", bs.data.posts.every((p: any) => !p.labels.length && !p.subscribersOnly), bs.data.posts);

  // human check, reports
  check("verify", (await call("POST", "/v1/social/me/verify", ANU)).status === 200);
  check("verify is idempotent", (await call("POST", "/v1/social/me/verify", ANU)).status === 200);
  check("reports reject non-legal reasons", (await call("POST", `/v1/social/posts/${pol.data.post.id}/reports`, MOON, { reason: "i_disagree" })).status === 422);
  const rep = await call("POST", `/v1/social/posts/${r1.data.post.id}/reports`, ANU, { reason: "fraud" });
  check("legal report queued", rep.status === 201, rep);
  check("non-admin can't see the queue", (await call("GET", "/v1/social/admin/reports", ANU)).status === 403);
  const q = await call("GET", "/v1/social/admin/reports", ADMIN);
  check("admin sees the queue", q.data.length === 1, q);
  await call("POST", `/v1/social/admin/reports/${r1.data.post.id}/resolve`, ADMIN, { decision: "removed" });
  check("removed post is gone", (await call("GET", `/v1/social/posts/${r1.data.post.id}`, ANU)).status === 404);

  // export + economics + money conservation
  const ex = await call("GET", "/v1/social/me/export", ANU);
  check("export has followers & posts", ex.data.followers.includes("marcus") && ex.data.posts.length >= 3, ex.data);
  const eco = await call("GET", "/v1/social/economics", null);
  // fees: tip 30 + sub 24 + feed 18 + forfeit 40 + verify 100 = 212
  check("platform revenue = 212 paise", eco.data.totalMinor === 212, eco.data);
  const bal = async (u: string) => (await call("GET", "/v1/social/me", u)).data.balanceMinor;
  const [a, m, mo] = [await bal(ANU), await bal(MARCUS), await bal(MOON)];
  // anu: 10000 -500 tip +376 sub +282 feed -100 verify = 10058 ; marcus: 10000 +470 +160 forfeit -400 sub -300 feed = 9930 ; moon: 10000 -200 = 9800
  check(`balances add up (anu ${a}, marcus ${m}, moon ${mo})`, a === 10058 && m === 9930 && mo === 9800);
  check("money is conserved: users + platform = top-ups", a + m + mo + eco.data.totalMinor === 30000);

  // expiry sweep via the cron entrypoint
  const r3 = await call("POST", "/v1/social/posts", MOON, { body: "gm ser", replyTo: pol.data.post.id });
  const { execSync } = await import("node:child_process");
  execSync(`psql "${env.PLATFORM_DB.connectionString}" -q -c "UPDATE wallet.reply_deposits SET expires_at = now() - interval '1 minute' WHERE status='held'"`);
  const waits: Promise<unknown>[] = [];
  await worker.scheduled!({} as any, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
  await Promise.all(waits);
  check("cron refunds expired deposits", (await bal(MOON)) === 9800, { moon: await bal(MOON), r3: r3.status });

  // concurrent retries with one key: one charge, and neither request errors
  const before = await bal(ANU);
  const race = await Promise.all([1, 2].map(() => call("POST", `/v1/social/posts/${p1.data.post.id}/tips`, ANU, { amountMinor: 100 }, { "idempotency-key": "race-1" })));
  check("concurrent retries both succeed", race.every((r) => r.status === 200 || r.status === 201), race);
  check("concurrent retries charge once", (await bal(ANU)) === before - 100, { before, after: await bal(ANU) });

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
