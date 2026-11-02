import {
  BUILTINS, builtin, filterHit, hiddenBy, hotScore, isBrandSafe, normaliseKeywords, rankHot, whyText,
  type Curation, type FeedPost,
} from "@social-worker/feed";

const NOW = Date.UTC(2026, 10, 2, 12);
const H = 3_600_000;
const post = (o: Partial<FeedPost> = {}): FeedPost => ({
  id: "p", authorId: "a", authorHandle: "anu", authorVerified: true, body: "hello world", labels: [],
  subscribersOnly: false, createdAtMs: NOW - H, replies: 0, tipsMinor: 0, ...o,
});
const community = (o: Partial<Curation>): Curation => ({
  id: "cur_x", kind: "filter", name: "Mine", description: "", ownerHandle: "lena", keywords: [], labels: [], priceMinor: 0, ...o,
});

describe("built-in filters", () => {
  it("hides by self-label", () => {
    expect(filterHit(builtin("f_politics")!, post({ labels: ["politics"] }))).toBe("labelled politics");
    expect(filterHit(builtin("f_politics")!, post())).toBeNull();
  });
  it("hides harsh language case-insensitively", () => {
    expect(filterHit(builtin("f_harsh")!, post({ body: "Some IDIOT keyed my car" }))).toContain("idiot");
  });
  it("verified-humans-only hides unverified authors", () => {
    expect(filterHit(builtin("f_verified")!, post({ authorVerified: false }))).toMatch(/verified/);
    expect(filterHit(builtin("f_verified")!, post())).toBeNull();
  });
  it("community filters match @handles", () => {
    expect(filterHit(community({ keywords: ["@moonboy"] }), post({ authorHandle: "moonboy" }))).toBe("posted by @moonboy");
  });
});

describe("hiddenBy", () => {
  const filters = [builtin("f_nsfw")!, builtin("f_crypto")!];
  it("returns the first filter that hides the post", () => {
    expect(hiddenBy(filters, post({ body: "airdrop now" }), "viewer")?.id).toBe("f_crypto");
  });
  it("never hides your own posts from you", () => {
    expect(hiddenBy(filters, post({ labels: ["nsfw"], authorId: "me" }), "me")).toBeNull();
  });
  it("hides nothing when no filters are on", () => {
    expect(hiddenBy([], post({ labels: ["nsfw"] }), null)).toBeNull();
  });
});

describe("Hot formula is the published one", () => {
  it("matches (2·tips + 1.5·replies + 1) / (hours + 2)^1.5 with tips in rupees", () => {
    const p = post({ tipsMinor: 1000, replies: 2, createdAtMs: NOW - 2 * H });
    expect(hotScore(p, NOW)).toBeCloseTo((2 * 10 + 1.5 * 2 + 1) / Math.pow(4, 1.5), 10);
  });
  it("decays with age and ranks a tipped post above an older one", () => {
    const fresh = post({ id: "fresh", tipsMinor: 500, createdAtMs: NOW - H });
    const old = post({ id: "old", tipsMinor: 500, createdAtMs: NOW - 30 * H });
    expect(rankHot([old, fresh], NOW).map((p) => p.id)).toEqual(["fresh", "old"]);
  });
});

describe("brand-safe", () => {
  it("excludes labels, paywalls and harsh words", () => {
    expect(isBrandSafe(post())).toBe(true);
    expect(isBrandSafe(post({ labels: ["religion"] }))).toBe(false);
    expect(isBrandSafe(post({ subscribersOnly: true }))).toBe(false);
    expect(isBrandSafe(post({ body: "this is shit" }))).toBe(false);
  });
});

describe("why am I seeing this", () => {
  it("explains the Hot score with real numbers", () => {
    expect(whyText(builtin("hot")!, post({ tipsMinor: 500, replies: 1 }), NOW, null)).toMatch(/₹5 tips \+ 1\.5·1 replies/);
  });
  it("names the curator for community feeds", () => {
    const feed = community({ kind: "feed", name: "Indie makers", ownerHandle: "marcus", keywords: ["indie"] });
    expect(whyText(feed, post({ body: "my indie game" }), NOW, null)).toBe("Curated feed “Indie makers” by @marcus matched “indie”.");
  });
});

describe("keywords", () => {
  it("normalises, de-dupes and caps at 30", () => {
    expect(normaliseKeywords(" Indie, indie ,@Marcus,")).toEqual(["indie", "@marcus"]);
    expect(normaliseKeywords(Array.from({ length: 50 }, (_, i) => `k${i}`))).toHaveLength(30);
  });
  it("ships exactly four built-in feeds", () => {
    expect(BUILTINS.filter((b) => b.kind === "feed").map((b) => b.id)).toEqual(["following", "latest", "hot", "brandsafe"]);
  });
});
