// KY4: the play-money wallet. Money UI only appears where money can enter: stage
// has a test top-up, prod has none, so tips, subscriptions and paywalls stay out of it.
import { K, api, h, fill, link, route, act, toast, requireSignIn, rupees, ago, postCard } from "./core.js";

const moneyOn = () => K.env && K.env !== "prod";
const KIND = { topup: "Top-up", tip: "Tip", creator_sub: "Subscription", curation_purchase: "Feed or filter", verify: "Human check", deposit_hold: "Deposit held", deposit_refund: "Deposit returned", deposit_forfeit: "Deposit forfeited", payout: "Payout" };

K.navLinks.unshift((nav) => (moneyOn() && K.me ? nav("/wallet", "Wallet") : null));

// Tip from a post.
K.postActions.push((p, paint) => {
  if (!moneyOn() || (K.me && K.me.profile && K.me.profile.handle === p.author.handle)) return null;
  if (!p.tipOpen) {
    return h("button", { class: "btn link", onclick: () => { if (!K.me) return requireSignIn(); p.tipOpen = true; paint(); return undefined; } },
      p.tipsMinor ? `Tip · ${rupees(p.tipsMinor)}` : "Tip");
  }
  return h("span", { class: "row" }, [500, 2000, 5000].map((amt) => h("button", { class: "btn", onclick: act(async () => {
    try {
      const r = await api("POST", `/v1/social/posts/${p.id}/tips`, { amountMinor: amt }, { idempotent: true });
      p.tipsMinor += amt; p.tipOpen = false;
      toast(`Tipped ${rupees(amt)}. @${p.author.handle} gets ${rupees(r.data.creatorNetMinor)}, Kuyil keeps ${rupees(r.data.feeMinor)}.`);
      paint();
    } catch (e) {
      if (e.code === "insufficient_funds") { toast("Not enough test money. Top up in your wallet."); return; }
      throw e;
    }
  }) }, rupees(amt))));
});

// Subscribers-only posting.
K.composerExtras.push(({ replyTo }) => {
  if (replyTo || !moneyOn()) return { el: null };
  const box = h("input", { type: "checkbox", id: "subs-only" });
  return {
    el: h("label", { class: "chip-toggle" }, box, "Subscribers only"),
    collect: () => ({ subscribersOnly: box.checked }),
    reset: () => { box.checked = false; },
  };
});

// Subscribe from a profile.
K.profileExtras.push((data, mine) => {
  if (mine || !moneyOn()) return null;
  if (data.subscribed) return h("span", { class: "chip" }, "Subscribed");
  return h("button", { class: "btn", onclick: act(async (e) => {
    const btn = e.currentTarget;
    if (!K.me) return requireSignIn();
    await api("POST", `/v1/social/users/${data.handle}/subscribe`, {}, { idempotent: true });
    toast(`Subscribed for 30 days.`);
    btn.replaceWith(h("span", { class: "chip" }, "Subscribed"));
    return undefined;
  }) }, `Subscribe · ${rupees(data.subPriceMinor)} / 30 days`);
});

// Creator price in settings.
K.settingsSections.push(() => {
  if (!moneyOn()) return null;
  const price = h("input", { type: "number", min: 1, max: 10000, step: 1, id: "sub-price", value: String(K.me.profile.subPriceMinor / 100) });
  return h("form", { class: "card", onsubmit: act(async (e) => {
    e.preventDefault();
    const { handle, bio } = K.me.profile;
    const subPriceMinor = Math.round(Number(price.value) * 100);
    await api("PUT", "/v1/social/me/profile", { handle, bio, subPriceMinor });
    K.me.profile.subPriceMinor = subPriceMinor;
    toast("Saved.");
  }) }, h("label", { class: "field" }, h("span", {}, "Your subscription price, per 30 days (test ₹)"), price), h("button", { class: "btn", type: "submit" }, "Save price"));
});

route(/^\/wallet$/, async () => {
  if (!K.me) { requireSignIn(); return null; }
  if (!moneyOn()) return h("div", { class: "empty" }, "Payments aren't available yet.");
  const box = h("div");
  const paint = async () => {
    const { data } = await api("GET", "/v1/social/me/wallet");
    fill(box, 
      h("h1", {}, "Wallet"),
      h("div", { class: "card" },
        h("div", { class: "amount" }, rupees(data.balanceMinor)),
        h("p", { class: "muted small" }, "Test money only. It can't be bought or withdrawn."),
        h("div", { class: "row" },
          h("button", { class: "btn primary", onclick: act(async () => {
            await api("POST", "/v1/social/me/wallet/dev-topup", { amountMinor: 10000 }, { idempotent: true });
            await paint();
          }) }, "Add ₹100 test money"),
          !K.me.verified && h("button", { class: "btn", onclick: act(async () => {
            await api("POST", "/v1/social/me/verify", {});
            K.me.verified = true; toast("You're marked as a verified human."); await paint();
          }) }, "Verify I'm human · ₹1"))),
      h("h2", {}, "Deposits waiting for you"),
      data.depositsAwaitingYou.length
        ? data.depositsAwaitingYou.map((p) => h("div", { class: "card" }, postCard(p),
            h("div", { class: "row" },
              h("button", { class: "btn", onclick: act(async () => { await api("POST", `/v1/social/deposits/${p.id}/refund`, {}); await paint(); }) }, "Fine, refund it"),
              h("button", { class: "btn danger", onclick: act(async () => { await api("POST", `/v1/social/deposits/${p.id}/forfeit`, {}); toast("Flagged as spam. You keep 80%."); await paint(); }) }, "Spam, keep it"))))
        : h("p", { class: "muted" }, "None. Replies from people you don't follow appear here, and refund themselves after 24 hours."),
      h("h2", {}, "History"),
      data.history.length
        ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "What"), h("th", {}, "With"), h("th", {}, "When"), h("th", { class: "num" }, "Amount"))),
            h("tbody", {}, data.history.map((r) => h("tr", {},
              h("td", {}, KIND[r.kind] || r.kind),
              h("td", {}, r.counterparty ? link(`/@${r.counterparty}`, {}, `@${r.counterparty}`) : "—"),
              h("td", { class: "muted" }, ago(r.createdAt)),
              h("td", { class: "num" }, `${r.amountMinor > 0 ? "+" : ""}${rupees(r.amountMinor)}`)))))
        : h("p", { class: "muted" }, "Nothing yet."),
    );
  };
  await paint();
  return box;
});
