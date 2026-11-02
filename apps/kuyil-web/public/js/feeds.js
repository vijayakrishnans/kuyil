// KY3: feed tabs from your preferences, "why am I seeing this", community feeds and filters.
import { K, api, h, fill, go, route, act, errorBox, toast, requireSignIn, rupees } from "./core.js";

const LABELS = ["politics", "nsfw", "crypto", "religion", "spoilers"];
let prefs = null;
let communityFeeds = new Map();

K.onMe.push(async (me) => {
  prefs = me ? me.prefs : null;
  K.activeFeed = prefs ? prefs.activeFeed : null;
  if (prefs && prefs.feeds.some((f) => f.startsWith("cur_"))) {
    try {
      const { data } = await api("GET", "/v1/social/curations?kind=feed");
      communityFeeds = new Map(data.community.map((c) => [c.id, c.name]));
    } catch { communityFeeds = new Map(); }
  }
});

const BUILTIN_NAMES = { following: "Following", latest: "Everything", hot: "Hot", brandsafe: "Brand-safe" };
K.homeTabs = () => {
  if (!prefs) return [["latest", "Everything"], ["hot", "Hot"], ["brandsafe", "Brand-safe"]];
  return prefs.feeds.map((id) => [id, BUILTIN_NAMES[id] || communityFeeds.get(id) || "Feed"]);
};

async function savePrefs(next) {
  const { data } = await api("PUT", "/v1/social/me/prefs", { feeds: prefs.feeds, filters: prefs.filters, activeFeed: prefs.activeFeed, ...next });
  prefs = { ...prefs, ...data };
  if (K.me) K.me.prefs = prefs;
  K.activeFeed = prefs.activeFeed;
}

K.rememberFeed = (id) => {
  if (!prefs || prefs.activeFeed === id) return;
  savePrefs({ activeFeed: id }).catch(() => { /* a tab choice is only a convenience */ });
};

K.navLinks.push((nav) => nav("/feeds", "Feeds"));

// "Why am I seeing this?" on every post that came from a feed.
K.postActions.push((p, paint) => p.why && h("button", { class: "btn link", onclick: () => { p.whyOpen = !p.whyOpen; paint(); } }, "Why this?"));
K.postDecorators.push((p) => (p.why && p.whyOpen ? h("div", { class: "why" }, p.why) : null));

// Label a post in the composer so readers' filters can act on it.
K.composerExtras.push(() => {
  const boxes = LABELS.map((l) => ({ l, input: h("input", { type: "checkbox" }) }));
  return {
    el: h("details", { class: "small" }, h("summary", { class: "muted" }, "Add labels"),
      h("div", { class: "chips" }, boxes.map((b) => h("label", { class: "chip-toggle" }, b.input, b.l)))),
    collect: () => ({ labels: boxes.filter((b) => b.input.checked).map((b) => b.l) }),
    reset: () => boxes.forEach((b) => { b.input.checked = false; }),
  };
});

function curationRow(c, kind, repaint) {
  const list = kind === "feed" ? "feeds" : "filters";
  const on = !!prefs && prefs[list].includes(c.id);
  const locked = c.priceMinor > 0 && c.unlocked === false;
  const toggle = act(async () => {
    if (!K.me) return requireSignIn();
    const next = on ? prefs[list].filter((x) => x !== c.id) : [...prefs[list], c.id];
    if (kind === "feed" && !next.length) { toast("Keep at least one feed."); return undefined; }
    const patch = { [list]: next };
    if (kind === "feed" && !next.includes(prefs.activeFeed)) patch.activeFeed = next[0];
    await savePrefs(patch);
    if (kind === "feed") communityFeeds.set(c.id, c.name);
    repaint();
    return undefined;
  });
  return h("div", { class: "card" },
    h("div", { class: "row" },
      h("div", { class: "grow" },
        h("strong", {}, c.name),
        c.ownerHandle && h("span", { class: "muted small" }, ` by @${c.ownerHandle}`),
        c.priceMinor > 0 && h("span", { class: "chip" }, rupees(c.priceMinor)),
        h("div", { class: "muted small" }, c.description),
        (c.keywords.length > 0 || c.labels.length > 0) && h("div", { class: "muted small" }, "Matches: ", [...c.labels, ...c.keywords].join(", "))),
      locked
        ? h("button", { class: "btn", onclick: act(async () => {
            if (!K.me) return requireSignIn();
            await api("POST", `/v1/social/curations/${c.id}/purchase`, {}, { idempotent: true });
            toast("Unlocked."); repaint(); return undefined;
          }) }, `Buy ${rupees(c.priceMinor)}`)
        : h("button", { class: `btn ${on ? "" : "primary"}`, onclick: toggle, "aria-pressed": String(on) }, on ? (kind === "feed" ? "Added" : "On") : (kind === "feed" ? "Add" : "Turn on")),
      c.owned && h("button", { class: "btn link danger", onclick: act(async () => {
        await api("DELETE", `/v1/social/curations/${c.id}`);
        if (prefs[list].includes(c.id)) await savePrefs({ [list]: prefs[list].filter((x) => x !== c.id) });
        repaint();
      }) }, "Delete")));
}

function publishForm(repaint) {
  const kind = h("select", { id: "cur-kind" }, h("option", { value: "filter" }, "Filter: hide matching posts"), h("option", { value: "feed" }, "Feed: show matching posts"));
  const name = h("input", { type: "text", maxlength: 40, id: "cur-name" });
  const description = h("input", { type: "text", maxlength: 140, id: "cur-desc" });
  const keywords = h("input", { type: "text", id: "cur-keywords", placeholder: "indie, gamedev, @marcus" });
  const price = h("input", { type: "number", min: 0, max: 10000, step: 1, value: "0", id: "cur-price" });
  const err = h("div");
  return h("details", { class: "card" }, h("summary", {}, h("strong", {}, "Publish your own")),
    h("form", { onsubmit: act(async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        await api("POST", "/v1/social/curations", { kind: kind.value, name: name.value, description: description.value, keywords: keywords.value, priceMinor: K.env === "prod" ? 0 : Math.round(Number(price.value) * 100) });
        toast("Published."); repaint();
      } catch (x) {
        const f = x.details && x.details.fields;
        err.replaceChildren(errorBox(f ? new Error(Object.values(f).join(" ")) : x));
      }
    }) },
      h("label", { class: "field" }, h("span", {}, "Type"), kind),
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Description"), description),
      h("label", { class: "field" }, h("span", {}, "Keywords and @handles, separated by commas"), keywords),
      K.env !== "prod" && h("label", { class: "field" }, h("span", {}, "Price in test rupees (0 is free)"), price),
      err, h("button", { class: "btn primary", type: "submit" }, "Publish")));
}

route(/^\/feeds$/, () => {
  const box = h("div");
  const repaint = async () => {
    try {
      const [feeds, filters] = await Promise.all([api("GET", "/v1/social/curations?kind=feed"), api("GET", "/v1/social/curations?kind=filter")]);
      fill(box, 
        h("h1", {}, "Feeds and filters"),
        h("p", { class: "muted" }, "You choose what you see. Filters collapse posts and tell you why, so nothing is secretly removed."),
        K.me && K.me.profile && publishForm(repaint),
        h("h2", {}, "Filters"),
        [...filters.data.builtin, ...filters.data.community]
          // Nobody can pay for the human check in prod yet, so this filter would hide everyone.
          .filter((c) => !(K.env === "prod" && c.id === "f_verified"))
          .map((c) => curationRow(c, "filter", repaint)),
        h("h2", {}, "Feeds"),
        [...feeds.data.builtin, ...feeds.data.community].map((c) => curationRow(c, "feed", repaint)),
        !K.me && h("p", { class: "muted" }, "Sign in to turn these on."),
      );
    } catch (x) { fill(box, errorBox(x)); }
  };
  repaint();
  return box;
});

export { go };
