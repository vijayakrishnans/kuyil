import * as social from "@saas/db/social";
import * as wallet from "@saas/db/wallet";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";
import {
  BUILTINS, BUILTIN_FEEDS, builtin, hiddenBy, isBrandSafe, normaliseKeywords, rankHot, splitKeywords, whyText,
  type Curation, type FeedPost,
} from "./feed.js";
import {
  decodeCursor, encodeCursor, errorResponse, forbidden, json, notFound, parseCurationRef, parsePub, pub, readJson,
  unauthenticated, validation,
} from "./http.js";

export interface Ctx {
  env: Env;
  rid: string;
  request: Request;
  url: URL;
  ex: TransactionalSqlExecutor;
  /** Viewer's identity user id as a UUID, or null for anonymous reads. */
  viewer: string | null;
}

const PAGE = 30;
const HANDLE_RE = /^[a-z0-9_]{2,20}$/;

// ── presentation ────────────────────────────────────────────

function toCuration(c: social.CurationRow, ownerHandle: string | null): Curation {
  return {
    id: pub("cur", c.id), kind: c.kind, name: c.name, description: c.description, ownerHandle,
    keywords: c.keywords, labels: c.labels, priceMinor: c.price_minor,
  };
}

interface PresentOpts { feed?: Curation; filters?: Curation[]; noFilter?: boolean }

/** Turn rows into API posts: author, counts, tips, deposit, paywall, filter verdict, why. */
async function present(ctx: Ctx, rows: social.PostRow[], o: PresentOpts = {}) {
  const ids = rows.map((r) => r.id);
  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const replyIds = rows.filter((r) => r.reply_to).map((r) => r.id);
  const [profiles, tips, deposits, verified, subs] = await Promise.all([
    social.getProfiles(ctx.ex, authorIds),
    wallet.tipTotals(ctx.ex, ids),
    wallet.depositsForPosts(ctx.ex, replyIds),
    wallet.verifiedUsers(ctx.ex, authorIds),
    ctx.viewer ? wallet.activeSubscriptions(ctx.ex, ctx.viewer, authorIds) : Promise.resolve(new Set<string>()),
  ]);
  const now = Date.now();
  const out = rows.map((r) => {
    const handle = profiles.get(r.author_id)?.handle ?? "unknown";
    const fp: FeedPost = {
      id: r.id, authorId: r.author_id, authorHandle: handle, authorVerified: verified.has(r.author_id),
      body: r.body, labels: r.labels, subscribersOnly: r.subscribers_only,
      createdAtMs: new Date(r.created_at).getTime(), replies: Number(r.reply_count ?? 0), tipsMinor: tips.get(r.id) ?? 0,
    };
    const locked = r.subscribers_only && r.author_id !== ctx.viewer && !subs.has(r.author_id);
    const d = deposits.get(r.id);
    const hidden = o.noFilter || !o.filters ? null : hiddenBy(o.filters, fp, ctx.viewer);
    return {
      fp,
      api: {
        id: pub("pst", r.id),
        author: {
          id: pub("usr", r.author_id), handle, verified: fp.authorVerified,
          subPriceMinor: profiles.get(r.author_id)?.sub_price_minor ?? 500,
        },
        // The paywall is enforced here, server-side: a locked body never leaves the worker.
        body: locked ? null : r.body,
        locked,
        labels: r.labels,
        subscribersOnly: r.subscribers_only,
        replyTo: r.reply_to ? pub("pst", r.reply_to) : null,
        createdAt: new Date(r.created_at).toISOString(),
        replies: fp.replies,
        tipsMinor: fp.tipsMinor,
        deposit: d ? { amountMinor: Number(d.amount_minor), status: d.status, expiresAt: new Date(d.expires_at).toISOString() } : null,
        hidden,
        why: o.feed ? whyText(o.feed, fp, now, ctx.viewer) : null,
      },
    };
  });
  return out;
}

/** Viewer's active filters, resolved to definitions they are allowed to use. */
async function viewerFilters(ctx: Ctx, prefs: social.PrefsRow): Promise<Curation[]> {
  const out: Curation[] = [];
  const communityIds: string[] = [];
  for (const f of prefs.filters) {
    const b = builtin(f);
    if (b?.kind === "filter") out.push(b);
    else { const u = parsePub("cur", f); if (u) communityIds.push(u); }
  }
  if (communityIds.length && ctx.viewer) {
    const [defs, ok] = await Promise.all([social.getCurations(ctx.ex, communityIds), social.accessibleCurations(ctx.ex, ctx.viewer, communityIds)]);
    const owners = await social.getProfiles(ctx.ex, [...defs.values()].map((c) => c.owner_id));
    for (const id of communityIds) {
      const c = defs.get(id);
      if (c && c.kind === "filter" && ok.has(id)) out.push(toCuration(c, owners.get(c.owner_id)?.handle ?? null));
    }
  }
  return out;
}

const depositsEnabled = (ctx: Ctx) => ctx.env.REPLY_DEPOSITS_ENABLED === "true";

const requireViewer = (ctx: Ctx) => (ctx.viewer ? null : unauthenticated(ctx.rid));

async function requireProfile(ctx: Ctx): Promise<social.ProfileRow | Response> {
  const p = await social.getProfile(ctx.ex, ctx.viewer!);
  return p ?? errorResponse("profile_required", "Pick a handle first", 409, ctx.rid);
}

/** Map wallet failures to HTTP; anything else is rethrown. */
export function walletErrorResponse(e: unknown, rid: string): Response | null {
  if (wallet.isInsufficientFunds(e)) return errorResponse("insufficient_funds", "Not enough money in your wallet", 402, rid);
  if (e instanceof wallet.WalletError) {
    const status = { insufficient_funds: 402, invalid_amount: 422, not_found: 404, forbidden: 403, already_settled: 409 }[e.code];
    return errorResponse(e.code, e.message, status, rid);
  }
  return null;
}

// ── me ──────────────────────────────────────────────────────

export async function getMe(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const v = ctx.viewer!;
  const [profile, prefs, balanceMinor, counts, verified] = await Promise.all([
    social.getProfile(ctx.ex, v), social.getPrefs(ctx.ex, v), wallet.balance(ctx.ex, v),
    social.followCounts(ctx.ex, v), wallet.verifiedUsers(ctx.ex, [v]),
  ]);
  const admins = (ctx.env.SOCIAL_ADMINS ?? "").split(",").map((s) => s.trim());
  return json({
    id: pub("usr", v),
    profile: profile && { handle: profile.handle, bio: profile.bio, subPriceMinor: profile.sub_price_minor },
    prefs: { feeds: prefs.feeds, filters: prefs.filters, activeFeed: prefs.active_feed },
    balanceMinor, ...counts, verified: verified.has(v), isAdmin: admins.includes(pub("usr", v)),
  }, ctx.rid);
}

export async function putProfile(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const b = await readJson(ctx.request);
  const handle = String(b.handle ?? "").trim().toLowerCase();
  const bio = String(b.bio ?? "").trim();
  const price = Math.round(Number(b.subPriceMinor ?? 500));
  const errs: Record<string, string> = {};
  if (!HANDLE_RE.test(handle)) errs.handle = "2–20 characters: a–z, 0–9, _";
  if (bio.length > 160) errs.bio = "160 characters at most";
  if (!(price >= 100 && price <= 1_000_000)) errs.subPriceMinor = "Between ₹1 and ₹10,000";
  if (Object.keys(errs).length) return validation(ctx.rid, errs);
  const p = await social.upsertProfile(ctx.ex, { userId: ctx.viewer!, handle, bio, subPriceMinor: price });
  if (!p) return errorResponse("conflict", "That handle is taken", 409, ctx.rid);
  return json({ handle: p.handle, bio: p.bio, subPriceMinor: p.sub_price_minor }, ctx.rid);
}

export async function putPrefs(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const b = await readJson(ctx.request);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!parseCurationRef(x)) : []);
  const feeds = [...new Set(list(b.feeds))].slice(0, 20);
  const filters = [...new Set(list(b.filters))].slice(0, 20);
  const active = typeof b.activeFeed === "string" && feeds.includes(b.activeFeed) ? b.activeFeed : feeds[0] ?? "latest";
  if (!feeds.length) return validation(ctx.rid, { feeds: "Keep at least one feed" });
  await social.putPrefs(ctx.ex, ctx.viewer!, { feeds, filters, active_feed: active });
  return json({ feeds, filters, activeFeed: active }, ctx.rid);
}

export async function verify(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  await ctx.ex.transaction(async (tx) => {
    await wallet.verifyHuman(tx, ctx.viewer!);
    await social.markVerified(tx, ctx.viewer!);
  });
  return json({ verified: true }, ctx.rid);
}

export async function getWallet(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const [balanceMinor, rows, held] = await Promise.all([
    wallet.balance(ctx.ex, ctx.viewer!), wallet.history(ctx.ex, ctx.viewer!), wallet.heldDepositsFor(ctx.ex, ctx.viewer!),
  ]);
  const people = await social.getProfiles(ctx.ex, [...new Set(rows.map((r) => r.ref_user_id).filter((x): x is string => !!x))]);
  const posts = await Promise.all(held.map((d) => social.getPost(ctx.ex, d.post_id)));
  const presented = await present(ctx, posts.filter((p): p is social.PostRow => !!p), { noFilter: true });
  return json({
    balanceMinor,
    history: rows.map((r) => ({
      kind: r.kind, amountMinor: Number(r.amount_minor), createdAt: new Date(r.created_at).toISOString(),
      post: r.ref_post_id ? pub("pst", r.ref_post_id) : null,
      counterparty: r.ref_user_id ? (people.get(r.ref_user_id)?.handle ?? null) : null,
    })),
    depositsAwaitingYou: presented.map((x) => x.api),
  }, ctx.rid);
}

export async function devTopUp(ctx: Ctx) {
  if (ctx.env.ENVIRONMENT === "prod") return notFound(ctx.rid);
  const deny = requireViewer(ctx); if (deny) return deny;
  const b = await readJson(ctx.request);
  const amount = Math.round(Number(b.amountMinor ?? 10_000));
  if (!(amount > 0 && amount <= 50_000)) return validation(ctx.rid, { amountMinor: "Up to ₹500 per dev top-up" });
  const key = ctx.request.headers.get("idempotency-key") ?? crypto.randomUUID();
  await ctx.ex.transaction((tx) => wallet.topUp(tx, { userId: ctx.viewer!, amountMinor: amount, idempotencyKey: key, source: `dev:${ctx.env.ENVIRONMENT}` }));
  return json({ balanceMinor: await wallet.balance(ctx.ex, ctx.viewer!) }, ctx.rid);
}

export async function exportMe(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const [graph, posts] = await Promise.all([
    social.followerHandles(ctx.ex, ctx.viewer!), social.postsByAuthor(ctx.ex, ctx.viewer!, 5000, null),
  ]);
  return json({
    format: "kuyil-export-v1", exportedAt: new Date().toISOString(), handle: prof.handle, bio: prof.bio,
    followers: graph.followers, following: graph.following,
    posts: posts.map((p) => ({ id: pub("pst", p.id), body: p.body, labels: p.labels, subscribersOnly: p.subscribers_only, replyTo: p.reply_to ? pub("pst", p.reply_to) : null, createdAt: new Date(p.created_at).toISOString() })),
  }, ctx.rid);
}

// ── feeds ───────────────────────────────────────────────────

export async function getFeed(ctx: Ctx, feedRef: string) {
  const ref = parseCurationRef(feedRef);
  if (!ref) return notFound(ctx.rid, "No such feed");
  let feed: Curation;
  let community: social.CurationRow | null = null;
  if ("builtin" in ref) {
    const b = builtin(ref.builtin);
    if (!b || b.kind !== "feed") return notFound(ctx.rid, "No such feed");
    feed = b;
  } else {
    community = (await social.getCurations(ctx.ex, [ref.uuid])).get(ref.uuid) ?? null;
    if (!community || community.kind !== "feed") return notFound(ctx.rid, "No such feed");
    const owner = await social.getProfile(ctx.ex, community.owner_id);
    feed = toCuration(community, owner?.handle ?? null);
    if (community.price_minor > 0) {
      const ok = ctx.viewer && (await social.accessibleCurations(ctx.ex, ctx.viewer, [community.id])).has(community.id);
      if (!ok) return errorResponse("payment_required", `“${community.name}” is a paid feed`, 402, ctx.rid, { priceMinor: community.price_minor, curation: feed.id });
    }
  }
  if (feed.id === "following" && !ctx.viewer) return unauthenticated(ctx.rid);

  const cursor = decodeCursor(ctx.url.searchParams.get("cursor"));
  const prefs = ctx.viewer ? await social.getPrefs(ctx.ex, ctx.viewer) : { feeds: [...BUILTIN_FEEDS], filters: ["f_nsfw"], active_feed: "latest" };
  const filters = await viewerFilters(ctx, prefs);

  let rows: social.PostRow[];
  if (feed.id === "following") rows = await social.timeline(ctx.ex, { limit: PAGE, cursor, followerOf: ctx.viewer! });
  else if (feed.id === "latest") rows = await social.timeline(ctx.ex, { limit: PAGE, cursor });
  else if (feed.id === "hot") rows = await social.timeline(ctx.ex, { limit: 300, cursor: null, sinceHours: 72 });
  else if (feed.id === "brandsafe") rows = await social.timeline(ctx.ex, { limit: PAGE, cursor, unlabelledOnly: true, publicOnly: true });
  else {
    const { words, handles } = splitKeywords(community!.keywords);
    rows = await social.timeline(ctx.ex, { limit: PAGE, cursor, keywords: words, handles, labels: community!.labels });
  }

  let items = await present(ctx, rows, { feed, filters });
  if (feed.id === "hot") {
    const order = rankHot(items.map((i) => i.fp), Date.now()).slice(0, 50).map((p) => p.id);
    const byId = new Map(items.map((i) => [i.fp.id, i]));
    items = order.map((id) => byId.get(id)!);
  }
  if (feed.id === "brandsafe") items = items.filter((i) => isBrandSafe(i.fp));
  const last = rows[rows.length - 1];
  const next = feed.id !== "hot" && rows.length === PAGE && last ? encodeCursor(last.created_at, last.id) : null;
  return json({ feed, posts: items.map((i) => i.api) }, ctx.rid, 200, next);
}

// ── posts ───────────────────────────────────────────────────

export async function createPost(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const b = await readJson(ctx.request);
  const body = String(b.body ?? "").trim();
  const labels = Array.isArray(b.labels) ? [...new Set(b.labels.filter((l): l is social.Label => (social.LABELS as readonly string[]).includes(l as string)))] : [];
  const replyTo = b.replyTo == null ? null : parsePub("pst", String(b.replyTo));
  if (!body || body.length > 500) return validation(ctx.rid, { body: "1–500 characters" });
  if (b.replyTo != null && !replyTo) return validation(ctx.rid, { replyTo: "Not a post id" });

  const result = await ctx.ex.transaction(async (tx) => {
    let deposit: { amountMinor: number } | null = null;
    let parent: social.PostRow | null = null;
    if (replyTo) {
      parent = await social.getPost(tx, replyTo);
      if (!parent || parent.removed_at) return { missing: true as const };
    }
    const post = await social.createPost(tx, { authorId: ctx.viewer!, body, labels, subscribersOnly: !replyTo && b.subscribersOnly === true, replyTo });
    // A stranger's reply holds a deposit: the parent's author doesn't follow the replier.
    if (depositsEnabled(ctx) && parent && parent.author_id !== ctx.viewer && !(await social.follows(tx, parent.author_id, ctx.viewer!))) {
      deposit = await wallet.holdDeposit(tx, { payer: ctx.viewer!, payee: parent.author_id, postId: post.id });
    }
    return { post, deposit };
  });
  if ("missing" in result) return notFound(ctx.rid, "That post is gone");
  const [item] = await present(ctx, [result.post], { noFilter: true });
  return json({ post: item!.api, depositMinor: result.deposit?.amountMinor ?? 0 }, ctx.rid, 201);
}

export async function getThread(ctx: Ctx, postRef: string) {
  const id = parsePub("pst", postRef);
  if (!id) return notFound(ctx.rid);
  const post = await social.getPost(ctx.ex, id);
  if (!post || post.removed_at) return notFound(ctx.rid, "That post is gone");
  const t = await social.thread(ctx.ex, id);
  const prefs = ctx.viewer ? await social.getPrefs(ctx.ex, ctx.viewer) : { feeds: [], filters: ["f_nsfw"], active_feed: "latest" };
  const filters = await viewerFilters(ctx, prefs);
  const [anc, main, reps] = await Promise.all([
    present(ctx, t.ancestors, { filters }), present(ctx, [post], { noFilter: true }), present(ctx, t.replies, { filters }),
  ]);
  const needsDeposit = depositsEnabled(ctx) && !!ctx.viewer && post.author_id !== ctx.viewer && !(await social.follows(ctx.ex, post.author_id, ctx.viewer));
  return json({
    ancestors: anc.map((x) => x.api), post: main[0]!.api, replies: reps.map((x) => x.api),
    replyDepositMinor: needsDeposit ? wallet.DEPOSIT_MINOR : 0,
  }, ctx.rid);
}

export async function tipPost(ctx: Ctx, postRef: string) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const id = parsePub("pst", postRef);
  const post = id ? await social.getPost(ctx.ex, id) : null;
  if (!post || post.removed_at) return notFound(ctx.rid);
  const b = await readJson(ctx.request);
  const amount = Math.round(Number(b.amountMinor));
  const r = await ctx.ex.transaction((tx) => wallet.tip(tx, {
    from: ctx.viewer!, to: post.author_id, amountMinor: amount, postId: post.id,
    idempotencyKey: ctx.request.headers.get("idempotency-key"),
  }));
  const { net, fee } = wallet.splitWithFee(amount);
  return json({ replayed: r.replayed, creatorNetMinor: net, feeMinor: fee }, ctx.rid, r.replayed ? 200 : 201);
}

export async function reportPost(ctx: Ctx, postRef: string) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const id = parsePub("pst", postRef);
  const post = id ? await social.getPost(ctx.ex, id) : null;
  if (!post || post.removed_at) return notFound(ctx.rid);
  const b = await readJson(ctx.request);
  const reason = String(b.reason ?? "");
  if (!(social.REPORT_REASONS as readonly string[]).includes(reason)) {
    return validation(ctx.rid, { reason: `Reports are for illegal content only: ${social.REPORT_REASONS.join(", ")}. Use a filter for everything else.` });
  }
  const created = await social.createReport(ctx.ex, { postId: post.id, reporterId: ctx.viewer!, reason: reason as social.ReportReason });
  return json({ queued: created }, ctx.rid, created ? 201 : 200);
}

export async function settleDeposit(ctx: Ctx, postRef: string, outcome: "refund" | "forfeit") {
  const deny = requireViewer(ctx); if (deny) return deny;
  const id = parsePub("pst", postRef);
  if (!id) return notFound(ctx.rid);
  const r = await ctx.ex.transaction((tx) => wallet.settleDeposit(tx, { postId: id, outcome, actorId: ctx.viewer! }));
  return json(r, ctx.rid);
}

// ── people ──────────────────────────────────────────────────

async function profileByHandle(ctx: Ctx, handle: string) {
  return HANDLE_RE.test(handle) ? social.getProfileByHandle(ctx.ex, handle) : null;
}

export async function getUser(ctx: Ctx, handle: string) {
  const p = await profileByHandle(ctx, handle);
  if (!p) return notFound(ctx.rid, "No such user");
  const v = ctx.viewer;
  const [counts, verified, youFollow, followsYou, subs, rows] = await Promise.all([
    social.followCounts(ctx.ex, p.user_id), wallet.verifiedUsers(ctx.ex, [p.user_id]),
    v ? social.follows(ctx.ex, v, p.user_id) : false, v ? social.follows(ctx.ex, p.user_id, v) : false,
    v ? wallet.activeSubscriptions(ctx.ex, v, [p.user_id]) : new Set<string>(),
    social.postsByAuthor(ctx.ex, p.user_id, PAGE, decodeCursor(ctx.url.searchParams.get("cursor"))),
  ]);
  const posts = await present(ctx, rows, { noFilter: true });
  const last = rows[rows.length - 1];
  return json({
    id: pub("usr", p.user_id), handle: p.handle, bio: p.bio, subPriceMinor: p.sub_price_minor, ...counts,
    verified: verified.has(p.user_id), youFollow, followsYou, subscribed: subs.has(p.user_id),
    posts: posts.map((x) => x.api),
  }, ctx.rid, 200, rows.length === PAGE && last ? encodeCursor(last.created_at, last.id) : null);
}

export async function setFollow(ctx: Ctx, handle: string, on: boolean) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const p = await profileByHandle(ctx, handle);
  if (!p) return notFound(ctx.rid, "No such user");
  if (p.user_id === ctx.viewer) return forbidden(ctx.rid, "You can't follow yourself");
  if (on) await social.follow(ctx.ex, ctx.viewer!, p.user_id); else await social.unfollow(ctx.ex, ctx.viewer!, p.user_id);
  return json({ following: on }, ctx.rid);
}

export async function subscribe(ctx: Ctx, handle: string) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const p = await profileByHandle(ctx, handle);
  if (!p) return notFound(ctx.rid, "No such user");
  const r = await ctx.ex.transaction((tx) => wallet.subscribeCreator(tx, {
    subscriber: ctx.viewer!, creator: p.user_id, priceMinor: p.sub_price_minor,
    idempotencyKey: ctx.request.headers.get("idempotency-key"),
  }));
  return json({ subscribed: true, replayed: r.replayed, priceMinor: p.sub_price_minor }, ctx.rid, r.replayed ? 200 : 201);
}

// ── curations ───────────────────────────────────────────────

export async function listCurations(ctx: Ctx) {
  const kind = ctx.url.searchParams.get("kind") === "filter" ? "filter" : "feed";
  const rows = await social.listCurations(ctx.ex, kind);
  const [owners, access] = await Promise.all([
    social.getProfiles(ctx.ex, [...new Set(rows.map((r) => r.owner_id))]),
    ctx.viewer ? social.accessibleCurations(ctx.ex, ctx.viewer, rows.map((r) => r.id)) : Promise.resolve(new Set<string>()),
  ]);
  return json({
    builtin: BUILTINS.filter((b) => b.kind === kind),
    community: rows.map((r) => ({ ...toCuration(r, owners.get(r.owner_id)?.handle ?? null), owned: r.owner_id === ctx.viewer, unlocked: r.price_minor === 0 || access.has(r.id) })),
  }, ctx.rid);
}

export async function createCuration(ctx: Ctx) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const b = await readJson(ctx.request);
  const kind = b.kind === "filter" ? "filter" : "feed";
  const name = String(b.name ?? "").trim();
  const description = String(b.description ?? "").trim().slice(0, 140);
  const keywords = normaliseKeywords(b.keywords);
  const labels = Array.isArray(b.labels) ? b.labels.filter((l): l is string => (social.LABELS as readonly string[]).includes(l as string)) : [];
  const price = Math.round(Number(b.priceMinor ?? 0));
  const errs: Record<string, string> = {};
  if (!name || name.length > 40) errs.name = "1–40 characters";
  if (!keywords.length && !labels.length) errs.keywords = "Add at least one keyword, @handle or label";
  if (!(price >= 0 && price <= 1_000_000)) errs.priceMinor = "Between free and ₹10,000";
  if (Object.keys(errs).length) return validation(ctx.rid, errs);
  const c = await social.createCuration(ctx.ex, { ownerId: ctx.viewer!, kind, name, description, keywords, labels, priceMinor: price });
  return json(toCuration(c, prof.handle), ctx.rid, 201);
}

export async function deleteCuration(ctx: Ctx, ref: string) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const id = parsePub("cur", ref);
  if (!id || !(await social.deleteCuration(ctx.ex, id, ctx.viewer!))) return notFound(ctx.rid);
  return json({ deleted: true }, ctx.rid);
}

export async function purchaseCuration(ctx: Ctx, ref: string) {
  const deny = requireViewer(ctx); if (deny) return deny;
  const prof = await requireProfile(ctx); if (prof instanceof Response) return prof;
  const id = parsePub("cur", ref);
  const c = id ? (await social.getCurations(ctx.ex, [id])).get(id) : undefined;
  if (!c) return notFound(ctx.rid);
  if (c.price_minor === 0 || c.owner_id === ctx.viewer) return json({ unlocked: true, chargedMinor: 0 }, ctx.rid);
  if ((await social.accessibleCurations(ctx.ex, ctx.viewer!, [c.id])).has(c.id)) return json({ unlocked: true, chargedMinor: 0 }, ctx.rid);
  await ctx.ex.transaction(async (tx) => {
    const t = await wallet.purchaseCuration(tx, {
      buyer: ctx.viewer!, owner: c.owner_id, curationId: c.id, priceMinor: c.price_minor,
      idempotencyKey: ctx.request.headers.get("idempotency-key"),
    });
    await social.grantCuration(tx, ctx.viewer!, c.id, t.transferId);
  });
  return json({ unlocked: true, chargedMinor: c.price_minor }, ctx.rid, 201);
}

// ── legal queue & economics ─────────────────────────────────

function isAdmin(ctx: Ctx): boolean {
  if (!ctx.viewer) return false;
  return (ctx.env.SOCIAL_ADMINS ?? "").split(",").map((s) => s.trim()).includes(pub("usr", ctx.viewer));
}

export async function listReports(ctx: Ctx) {
  if (!isAdmin(ctx)) return forbidden(ctx.rid);
  const reports = await social.openReports(ctx.ex);
  const byPost = new Map<string, typeof reports>();
  for (const r of reports) byPost.set(r.post_id, [...(byPost.get(r.post_id) ?? []), r]);
  const posts = (await Promise.all([...byPost.keys()].map((id) => social.getPost(ctx.ex, id)))).filter((p): p is social.PostRow => !!p && !p.removed_at);
  const presented = await present(ctx, posts, { noFilter: true });
  return json(presented.map((x) => ({
    post: x.api,
    reports: (byPost.get(x.fp.id) ?? []).map((r) => ({ reason: r.reason, createdAt: new Date(r.created_at).toISOString() })),
  })), ctx.rid);
}

export async function resolveReport(ctx: Ctx, postRef: string) {
  if (!isAdmin(ctx)) return forbidden(ctx.rid);
  const id = parsePub("pst", postRef);
  if (!id) return notFound(ctx.rid);
  const b = await readJson(ctx.request);
  const decision = b.decision === "removed" ? "removed" : b.decision === "kept" ? "kept" : null;
  if (!decision) return validation(ctx.rid, { decision: "removed or kept" });
  await ctx.ex.transaction((tx) => social.resolveReports(tx, { postId: id, decision, adminId: ctx.viewer!, reason: typeof b.reason === "string" ? b.reason.slice(0, 200) : undefined }));
  return json({ decision }, ctx.rid);
}

export async function economics(ctx: Ctx) {
  const [rev, stats] = await Promise.all([wallet.revenue(ctx.ex), social.networkStats(ctx.ex)]);
  const totalMinor = Object.values(rev).reduce((a, b) => a + b, 0);
  return json({ revenueMinor: rev, totalMinor, ...stats, feeBps: wallet.FEE_BPS, forfeitCutBps: wallet.FORFEIT_CUT_BPS }, ctx.rid);
}

/** Cron: refund every held deposit whose 24h window has passed. */
export async function sweepExpiredDeposits(ex: TransactionalSqlExecutor): Promise<number> {
  const ids = await wallet.expiredDeposits(ex as SqlExecutor);
  let n = 0;
  for (const postId of ids) {
    try {
      await ex.transaction((tx) => wallet.settleDeposit(tx, { postId, outcome: "refund", actorId: null }));
      n++;
    } catch (e) {
      if (!(e instanceof wallet.WalletError && e.code === "already_settled")) throw e;
    }
  }
  return n;
}
