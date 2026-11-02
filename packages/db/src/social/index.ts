// Social bounded context — profiles, posts, follows, curations, prefs, reports.
// Pure SQL repository; ranking/filter policy lives in the social-worker's
// feed module so it can be unit-tested without a database.

import type { SqlExecutor } from "../hyperdrive/index.js";

/**
 * Render a JS array as a Postgres array literal, bound as ONE text param and
 * cast in SQL (`$1::uuid[]`, `$2::text[]`). The executor runs postgres.js with
 * `fetch_types: false`, so raw JS arrays have no element-type OID and fail to
 * bind (see membership/repository.ts, PERF3).
 */
export function pgArray(values: readonly string[]): string {
  return "{" + values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",") + "}";
}

/** Inverse of pgArray: `{a,"b c"}` → ["a","b c"]. Arrays come back as text under `fetch_types: false`. */
export function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== "string" || v.length < 2) return [];
  const s = v.slice(1, -1);
  if (!s) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === "\\") cur += s[++i] ?? "";
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const fixPost = <T extends { labels: unknown }>(r: T): T => ({ ...r, labels: parsePgArray(r.labels) });
const fixCuration = <T extends { keywords: unknown; labels: unknown }>(r: T): T => ({ ...r, keywords: parsePgArray(r.keywords), labels: parsePgArray(r.labels) });

export const LABELS = ["politics", "nsfw", "crypto", "religion", "spoilers"] as const;
export type Label = (typeof LABELS)[number];
export const REPORT_REASONS = ["csam", "credible_threat", "court_order", "ncii", "fraud"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type ProfileRow = { user_id: string; handle: string; bio: string; sub_price_minor: number; verified_at: string | null; created_at: string };
export type PostRow = {
  id: string; author_id: string; body: string; labels: Label[]; subscribers_only: boolean;
  reply_to: string | null; removed_at: string | null; created_at: string; reply_count?: string | number;
};
export type CurationRow = {
  id: string; owner_id: string; kind: "feed" | "filter"; name: string; description: string;
  keywords: string[]; labels: string[]; price_minor: number; created_at: string;
};
export type PrefsRow = { feeds: string[]; filters: string[]; active_feed: string };
export interface Cursor { createdAt: string; id: string }

const POST_COLS = `p.id, p.author_id, p.body, p.labels, p.subscribers_only, p.reply_to, p.removed_at, p.created_at,
  (SELECT count(*) FROM social.posts r WHERE r.reply_to = p.id AND r.removed_at IS NULL) AS reply_count`;

// ── Profiles ────────────────────────────────────────────────
export async function getProfile(ex: SqlExecutor, userId: string): Promise<ProfileRow | null> {
  const r = await ex.execute<ProfileRow>(`SELECT * FROM social.profiles WHERE user_id = $1`, [userId]);
  return r.rows[0] ?? null;
}
export async function getProfileByHandle(ex: SqlExecutor, handle: string): Promise<ProfileRow | null> {
  const r = await ex.execute<ProfileRow>(`SELECT * FROM social.profiles WHERE handle = $1`, [handle.toLowerCase()]);
  return r.rows[0] ?? null;
}
export async function getProfiles(ex: SqlExecutor, ids: string[]): Promise<Map<string, ProfileRow>> {
  if (!ids.length) return new Map();
  const r = await ex.execute<ProfileRow>(`SELECT * FROM social.profiles WHERE user_id = ANY($1::uuid[])`, [pgArray(ids)]);
  return new Map(r.rows.map((p) => [p.user_id, p]));
}
/** Create or update; returns null when the handle belongs to someone else. */
export async function upsertProfile(
  ex: SqlExecutor, p: { userId: string; handle: string; bio: string; subPriceMinor: number },
): Promise<ProfileRow | null> {
  const r = await ex.execute<ProfileRow>(
    `INSERT INTO social.profiles (user_id, handle, bio, sub_price_minor) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET handle = EXCLUDED.handle, bio = EXCLUDED.bio,
       sub_price_minor = EXCLUDED.sub_price_minor, updated_at = now()
     RETURNING *`,
    [p.userId, p.handle.toLowerCase(), p.bio, p.subPriceMinor],
  ).catch((e: { constraint_name?: string }) => {
    if (e?.constraint_name === "profiles_handle_idx") return null;
    throw e;
  });
  return r ? (r.rows[0] ?? null) : null;
}
export async function markVerified(ex: SqlExecutor, userId: string): Promise<void> {
  await ex.execute(`UPDATE social.profiles SET verified_at = COALESCE(verified_at, now()) WHERE user_id = $1`, [userId]);
}

// ── Preferences ─────────────────────────────────────────────
export async function getPrefs(ex: SqlExecutor, userId: string): Promise<PrefsRow> {
  const r = await ex.execute<PrefsRow>(`SELECT feeds, filters, active_feed FROM social.user_prefs WHERE user_id = $1`, [userId]);
  const row = r.rows[0];
  if (!row) return { feeds: ["following", "latest", "hot", "brandsafe"], filters: ["f_nsfw"], active_feed: "latest" };
  return { feeds: parsePgArray(row.feeds), filters: parsePgArray(row.filters), active_feed: row.active_feed };
}
export async function putPrefs(ex: SqlExecutor, userId: string, p: PrefsRow): Promise<void> {
  await ex.execute(
    `INSERT INTO social.user_prefs (user_id, feeds, filters, active_feed) VALUES ($1, $2::text[], $3::text[], $4)
     ON CONFLICT (user_id) DO UPDATE SET feeds = EXCLUDED.feeds, filters = EXCLUDED.filters,
       active_feed = EXCLUDED.active_feed, updated_at = now()`,
    [userId, pgArray(p.feeds), pgArray(p.filters), p.active_feed],
  );
}

// ── Posts ───────────────────────────────────────────────────
export async function createPost(
  ex: SqlExecutor,
  p: { authorId: string; body: string; labels: Label[]; subscribersOnly: boolean; replyTo: string | null },
): Promise<PostRow> {
  const r = await ex.execute<PostRow>(
    `INSERT INTO social.posts (id, author_id, body, labels, subscribers_only, reply_to)
     VALUES (gen_random_uuid(), $1, $2, $3::text[], $4, $5) RETURNING *, 0 AS reply_count`,
    [p.authorId, p.body, pgArray(p.labels), p.subscribersOnly, p.replyTo],
  );
  return fixPost(r.rows[0]!);
}
export async function getPost(ex: SqlExecutor, id: string): Promise<PostRow | null> {
  const r = await ex.execute<PostRow>(`SELECT ${POST_COLS} FROM social.posts p WHERE p.id = $1`, [id]);
  return r.rows[0] ? fixPost(r.rows[0]) : null;
}
/** Up to 6 ancestors (oldest first) and the direct replies of a post. */
export async function thread(ex: SqlExecutor, id: string): Promise<{ ancestors: PostRow[]; replies: PostRow[] }> {
  const a = await ex.execute<PostRow & { depth: number }>(
    `WITH RECURSIVE up AS (
       SELECT s.id, s.reply_to, 0 AS depth FROM social.posts s WHERE s.id = (SELECT reply_to FROM social.posts WHERE id = $1)
       UNION ALL
       SELECT s.id, s.reply_to, up.depth + 1 FROM social.posts s JOIN up ON s.id = up.reply_to WHERE up.depth < 5
     )
     SELECT ${POST_COLS}, up.depth FROM up JOIN social.posts p ON p.id = up.id ORDER BY up.depth DESC`,
    [id],
  );
  const r = await ex.execute<PostRow>(
    `SELECT ${POST_COLS} FROM social.posts p WHERE p.reply_to = $1 AND p.removed_at IS NULL ORDER BY p.created_at LIMIT 200`, [id],
  );
  return { ancestors: a.rows.filter((x) => !x.removed_at).map(fixPost), replies: r.rows.map(fixPost) };
}

function cursorClause(cursor: Cursor | null, n: number): string {
  return cursor ? `AND (p.created_at, p.id) < ($${n}::timestamptz, $${n + 1}::uuid)` : "";
}
function cursorParams(cursor: Cursor | null): unknown[] {
  return cursor ? [cursor.createdAt, cursor.id] : [];
}

/** Top-level posts, newest first. Optional author set / keyword / label match. */
export async function timeline(
  ex: SqlExecutor,
  q: {
    limit: number; cursor: Cursor | null;
    authors?: string[]; followerOf?: string; keywords?: string[]; handles?: string[]; labels?: string[];
    unlabelledOnly?: boolean; publicOnly?: boolean; sinceHours?: number;
  },
): Promise<PostRow[]> {
  const where: string[] = ["p.removed_at IS NULL", "p.reply_to IS NULL"];
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.followerOf) {
    const v = add(q.followerOf);
    where.push(`(p.author_id = ${v} OR p.author_id IN (SELECT followee_id FROM social.follows WHERE follower_id = ${v}))`);
  }
  if (q.authors?.length) where.push(`p.author_id = ANY(${add(pgArray(q.authors))}::uuid[])`);
  const any: string[] = [];
  if (q.keywords?.length) any.push(`lower(p.body) LIKE ANY(${add(pgArray(q.keywords.map((k) => `%${k.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`)))}::text[])`);
  if (q.handles?.length) any.push(`p.author_id IN (SELECT user_id FROM social.profiles WHERE handle = ANY(${add(pgArray(q.handles.map((h) => h.toLowerCase())))}::text[]))`);
  if (q.labels?.length) any.push(`p.labels && ${add(pgArray(q.labels))}::text[]`);
  if (any.length) where.push(`(${any.join(" OR ")})`);
  if (q.unlabelledOnly) where.push(`cardinality(p.labels) = 0`);
  if (q.publicOnly) where.push(`NOT p.subscribers_only`);
  if (q.sinceHours) where.push(`p.created_at > now() - make_interval(hours => ${add(q.sinceHours)})`);
  const cur = cursorClause(q.cursor, params.length + 1);
  params.push(...cursorParams(q.cursor));
  params.push(q.limit);
  const r = await ex.execute<PostRow>(
    `SELECT ${POST_COLS} FROM social.posts p WHERE ${where.join(" AND ")} ${cur}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(fixPost);
}

export async function postsByAuthor(ex: SqlExecutor, authorId: string, limit: number, cursor: Cursor | null): Promise<PostRow[]> {
  const r = await ex.execute<PostRow>(
    `SELECT ${POST_COLS} FROM social.posts p WHERE p.author_id = $1 AND p.removed_at IS NULL ${cursorClause(cursor, 2)}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${cursor ? 4 : 2}`,
    [authorId, ...cursorParams(cursor), limit],
  );
  return r.rows.map(fixPost);
}

// ── Follows ─────────────────────────────────────────────────
export async function follow(ex: SqlExecutor, follower: string, followee: string): Promise<void> {
  await ex.execute(`INSERT INTO social.follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [follower, followee]);
}
export async function unfollow(ex: SqlExecutor, follower: string, followee: string): Promise<void> {
  await ex.execute(`DELETE FROM social.follows WHERE follower_id = $1 AND followee_id = $2`, [follower, followee]);
}
export async function follows(ex: SqlExecutor, follower: string, followee: string): Promise<boolean> {
  const r = await ex.execute(`SELECT 1 FROM social.follows WHERE follower_id = $1 AND followee_id = $2`, [follower, followee]);
  return r.rowCount > 0;
}
export async function followCounts(ex: SqlExecutor, userId: string): Promise<{ followers: number; following: number }> {
  const r = await ex.execute<{ followers: string; following: string }>(
    `SELECT (SELECT count(*) FROM social.follows WHERE followee_id = $1) AS followers,
            (SELECT count(*) FROM social.follows WHERE follower_id = $1) AS following`, [userId],
  );
  return { followers: Number(r.rows[0]?.followers ?? 0), following: Number(r.rows[0]?.following ?? 0) };
}
/** Handles only — the portable audience export. */
export async function followerHandles(ex: SqlExecutor, userId: string): Promise<{ followers: string[]; following: string[] }> {
  const a = await ex.execute<{ handle: string }>(
    `SELECT pr.handle FROM social.follows f JOIN social.profiles pr ON pr.user_id = f.follower_id WHERE f.followee_id = $1 ORDER BY pr.handle`, [userId]);
  const b = await ex.execute<{ handle: string }>(
    `SELECT pr.handle FROM social.follows f JOIN social.profiles pr ON pr.user_id = f.followee_id WHERE f.follower_id = $1 ORDER BY pr.handle`, [userId]);
  return { followers: a.rows.map((x) => x.handle), following: b.rows.map((x) => x.handle) };
}

// ── Curations ───────────────────────────────────────────────
export async function listCurations(ex: SqlExecutor, kind: "feed" | "filter"): Promise<CurationRow[]> {
  const r = await ex.execute<CurationRow>(
    `SELECT * FROM social.curations WHERE kind = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200`, [kind]);
  return r.rows.map(fixCuration);
}
export async function getCurations(ex: SqlExecutor, ids: string[]): Promise<Map<string, CurationRow>> {
  const uuids = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!uuids.length) return new Map();
  const r = await ex.execute<CurationRow>(`SELECT * FROM social.curations WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [pgArray(uuids)]);
  return new Map(r.rows.map((c) => [c.id, fixCuration(c)]));
}
export async function createCuration(
  ex: SqlExecutor,
  c: { ownerId: string; kind: "feed" | "filter"; name: string; description: string; keywords: string[]; labels: string[]; priceMinor: number },
): Promise<CurationRow> {
  const r = await ex.execute<CurationRow>(
    `INSERT INTO social.curations (id, owner_id, kind, name, description, keywords, labels, price_minor)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::text[], $6::text[], $7) RETURNING *`,
    [c.ownerId, c.kind, c.name, c.description, pgArray(c.keywords), pgArray(c.labels), c.priceMinor],
  );
  return fixCuration(r.rows[0]!);
}
export async function deleteCuration(ex: SqlExecutor, id: string, ownerId: string): Promise<boolean> {
  const r = await ex.execute(`UPDATE social.curations SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING id`, [id, ownerId]);
  return r.rowCount > 0;
}
export async function accessibleCurations(ex: SqlExecutor, userId: string, ids: string[]): Promise<Set<string>> {
  const uuids = ids.filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (!uuids.length) return new Set();
  const r = await ex.execute<{ id: string }>(
    `SELECT c.id FROM social.curations c
      WHERE c.id = ANY($2::uuid[]) AND (c.price_minor = 0 OR c.owner_id = $1
        OR EXISTS (SELECT 1 FROM social.curation_access a WHERE a.user_id = $1 AND a.curation_id = c.id))`,
    [userId, pgArray(uuids)],
  );
  return new Set(r.rows.map((x) => x.id));
}
export async function grantCuration(ex: SqlExecutor, userId: string, curationId: string, transferId: string): Promise<void> {
  await ex.execute(
    `INSERT INTO social.curation_access (user_id, curation_id, transfer_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, curationId, transferId],
  );
}

// ── Reports (legal floor) ───────────────────────────────────
export async function createReport(ex: SqlExecutor, p: { postId: string; reporterId: string; reason: ReportReason }): Promise<boolean> {
  const r = await ex.execute(
    `INSERT INTO social.reports (id, post_id, reporter_id, reason) VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
    [p.postId, p.reporterId, p.reason],
  );
  return r.rowCount > 0;
}
export async function openReports(ex: SqlExecutor): Promise<Array<{ id: string; post_id: string; reporter_id: string; reason: ReportReason; created_at: string }>> {
  const r = await ex.execute<{ id: string; post_id: string; reporter_id: string; reason: ReportReason; created_at: string }>(
    `SELECT id, post_id, reporter_id, reason, created_at FROM social.reports WHERE status = 'open' ORDER BY created_at LIMIT 200`);
  return r.rows;
}
/** Resolve every open report on a post at once; removal soft-deletes the post. */
export async function resolveReports(ex: SqlExecutor, p: { postId: string; decision: "removed" | "kept"; adminId: string; reason?: string | undefined }): Promise<void> {
  await ex.execute(
    `UPDATE social.reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE post_id = $1 AND status = 'open'`,
    [p.postId, p.decision, p.adminId],
  );
  if (p.decision === "removed") {
    await ex.execute(
      `UPDATE social.posts SET removed_at = now(), removed_reason = $2 WHERE id = $1 AND removed_at IS NULL`,
      [p.postId, p.reason ?? "legal"],
    );
  }
}

export async function networkStats(ex: SqlExecutor): Promise<{ accounts: number; posts: number }> {
  const r = await ex.execute<{ a: string; p: string }>(
    `SELECT (SELECT count(*) FROM social.profiles) AS a, (SELECT count(*) FROM social.posts WHERE removed_at IS NULL) AS p`);
  return { accounts: Number(r.rows[0]?.a ?? 0), posts: Number(r.rows[0]?.p ?? 0) };
}
