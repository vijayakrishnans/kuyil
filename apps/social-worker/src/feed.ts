// Feed policy for Kuyil: built-in feeds and filters, filter matching, the
// public Hot formula, and the "why am I seeing this?" explanations.
// Pure functions — no I/O — so the rules users are promised are testable.

export type CurationKind = "feed" | "filter";

export interface Curation {
  id: string;
  kind: CurationKind;
  name: string;
  description: string;
  ownerHandle: string | null;
  keywords: string[];
  labels: string[];
  priceMinor: number;
}

export interface FeedPost {
  id: string;
  authorId: string;
  authorHandle: string;
  authorVerified: boolean;
  body: string;
  labels: string[];
  subscribersOnly: boolean;
  createdAtMs: number;
  replies: number;
  tipsMinor: number;
}

export const BUILTIN_FEEDS = ["following", "latest", "hot", "brandsafe"] as const;
export const HARSH_WORDS = ["fuck", "shit", "idiot", "bastard", "moron", "stupid"];

export const BUILTINS: Curation[] = [
  { id: "following", kind: "feed", name: "Following", description: "People you follow, newest first. No ranking at all.", ownerHandle: null, keywords: [], labels: [], priceMinor: 0 },
  { id: "latest", kind: "feed", name: "Everything", description: "Every public post on the network, newest first.", ownerHandle: null, keywords: [], labels: [], priceMinor: 0 },
  { id: "hot", kind: "feed", name: "Hot", description: "Public formula: (2·tips + 1.5·replies + 1) ÷ (hours + 2)^1.5. Nothing secret.", ownerHandle: null, keywords: [], labels: [], priceMinor: 0 },
  { id: "brandsafe", kind: "feed", name: "Brand-safe", description: "No self-labels, no harsh language, no paywalls. The only feed advertisers can buy space in.", ownerHandle: null, keywords: [], labels: [], priceMinor: 0 },
  { id: "f_nsfw", kind: "filter", name: "Hide NSFW", description: "Hides posts their authors labelled nsfw.", ownerHandle: null, keywords: [], labels: ["nsfw"], priceMinor: 0 },
  { id: "f_politics", kind: "filter", name: "Hide politics", description: "Hides posts labelled politics.", ownerHandle: null, keywords: [], labels: ["politics"], priceMinor: 0 },
  { id: "f_harsh", kind: "filter", name: "Harsh language", description: "Hides posts with swearing and insults.", ownerHandle: null, keywords: HARSH_WORDS, labels: [], priceMinor: 0 },
  { id: "f_crypto", kind: "filter", name: "No crypto shilling", description: "Hides crypto-labelled posts and airdrop spam.", ownerHandle: null, keywords: ["airdrop", "100x", "to the moon"], labels: ["crypto"], priceMinor: 0 },
  { id: "f_verified", kind: "filter", name: "Verified humans only", description: "Hides anyone who has not paid the ₹1 human check.", ownerHandle: null, keywords: [], labels: [], priceMinor: 0 },
];

export const builtin = (id: string): Curation | undefined => BUILTINS.find((c) => c.id === id);

/** Split a curation's keyword list into plain words and @handles. */
export function splitKeywords(keywords: string[]): { words: string[]; handles: string[] } {
  const words: string[] = [], handles: string[] = [];
  for (const raw of keywords) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    if (k.startsWith("@")) handles.push(k.slice(1)); else words.push(k);
  }
  return { words, handles };
}

/** Normalise user-entered keywords: trimmed, lower-case, unique, ≤30, each ≤40 chars. */
export function normaliseKeywords(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const out = new Set<string>();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const k = v.trim().toLowerCase().slice(0, 40);
    if (k) out.add(k);
    if (out.size >= 30) break;
  }
  return [...out];
}

/** Why `c` (a filter) hides `p`, or null if it doesn't. */
export function filterHit(c: Curation, p: FeedPost): string | null {
  if (c.id === "f_verified") return p.authorVerified ? null : "author is not a verified human";
  const label = c.labels.find((l) => p.labels.includes(l));
  if (label) return `labelled ${label}`;
  const { words, handles } = splitKeywords(c.keywords);
  if (handles.includes(p.authorHandle.toLowerCase())) return `posted by @${p.authorHandle}`;
  const body = p.body.toLowerCase();
  const word = words.find((w) => body.includes(w));
  if (word) return `contains “${word}”`;
  return null;
}

/** First of the viewer's filters that hides this post. Your own posts are never hidden from you. */
export function hiddenBy(filters: Curation[], p: FeedPost, viewerId: string | null): { id: string; name: string; reason: string } | null {
  if (viewerId && p.authorId === viewerId) return null;
  for (const c of filters) {
    const reason = filterHit(c, p);
    if (reason) return { id: c.id, name: c.name, reason };
  }
  return null;
}

/** Does a community feed include this post? */
export function feedMatches(c: Curation, p: FeedPost): string | null {
  const label = c.labels.find((l) => p.labels.includes(l));
  if (label) return `label ${label}`;
  const { words, handles } = splitKeywords(c.keywords);
  if (handles.includes(p.authorHandle.toLowerCase())) return `@${p.authorHandle}`;
  const body = p.body.toLowerCase();
  const word = words.find((w) => body.includes(w));
  return word ? `“${word}”` : null;
}

export function isBrandSafe(p: FeedPost): boolean {
  if (p.labels.length || p.subscribersOnly) return false;
  const body = p.body.toLowerCase();
  return !HARSH_WORDS.some((w) => body.includes(w));
}

const HOUR = 3_600_000;

/** The Hot formula, exactly as published. Tips are counted in whole rupees. */
export function hotScore(p: FeedPost, nowMs: number): number {
  const hours = Math.max(0, (nowMs - p.createdAtMs) / HOUR);
  return (2 * (p.tipsMinor / 100) + 1.5 * p.replies + 1) / Math.pow(hours + 2, 1.5);
}

export function rankHot(posts: FeedPost[], nowMs: number): FeedPost[] {
  return [...posts].sort((a, b) => hotScore(b, nowMs) - hotScore(a, nowMs) || b.createdAtMs - a.createdAtMs);
}

export function whyText(feed: Curation, p: FeedPost, nowMs: number, viewerId: string | null): string {
  switch (feed.id) {
    case "following":
      return p.authorId === viewerId ? "Your own post." : `You follow @${p.authorHandle}. Shown in time order. Nothing was boosted or buried.`;
    case "latest":
      return "Everything feed: every public post in time order. Nobody ranked it.";
    case "hot": {
      const h = ((nowMs - p.createdAtMs) / HOUR).toFixed(1);
      return `Score ${hotScore(p, nowMs).toFixed(3)} = (2·₹${p.tipsMinor / 100} tips + 1.5·${p.replies} replies + 1) ÷ (${h}h + 2)^1.5. Your follows don't change it, and no one paid to boost it.`;
    }
    case "brandsafe":
      return "No self-labels, no harsh words, not paywalled, so it qualifies for the brand-safe feed.";
    default: {
      const m = feedMatches(feed, p);
      return `Curated feed “${feed.name}”${feed.ownerHandle ? ` by @${feed.ownerHandle}` : ""} matched ${m ?? "its rules"}.`;
    }
  }
}
