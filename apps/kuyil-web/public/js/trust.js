// KY5: legal reports and their queue, your audience export, the economics page, and what Kuyil promises.
import { K, api, h, fill, link, route, act, toast, requireSignIn, rupees, postCard } from "./core.js";

const REASONS = [["csam", "Child sexual abuse material"], ["credible_threat", "A credible threat of violence"], ["ncii", "Intimate images shared without consent"], ["fraud", "Fraud"], ["court_order", "Subject to a court order"]];

K.navLinks.push((nav) => nav("/about", "About"));
K.navLinks.push((nav) => (K.me && K.me.isAdmin ? nav("/admin/reports", "Legal queue") : null));

K.heroExtras.push(() => h("ul", { class: "points" },
  h("li", {}, "✓ Take your followers and posts with you, any time."),
  h("li", {}, "✓ Every ranking shows its working. No hidden throttling."),
  h("li", {}, "✓ You pick your own filters, or anyone else's."),
));

// Report: only the legal reasons exist. Everything else is what filters are for.
K.postActions.push((p, paint) => {
  if (K.me && K.me.profile && K.me.profile.handle === p.author.handle) return null;
  if (!p.reportOpen) return h("button", { class: "btn link", onclick: () => { if (!K.me) return requireSignIn(); p.reportOpen = true; paint(); return undefined; } }, "Report");
  const reason = h("select", { "aria-label": "Report reason" }, REASONS.map(([v, l]) => h("option", { value: v }, l)));
  return h("div", { class: "why" },
    h("p", { style: null }, "Reports are for illegal content. For anything else you'd rather not see, ", link("/feeds", {}, "use a filter"), "."),
    reason,
    h("div", { class: "row" },
      h("button", { class: "btn", onclick: act(async () => {
        await api("POST", `/v1/social/posts/${p.id}/reports`, { reason: reason.value });
        p.reportOpen = false; toast("Report sent."); paint();
      }) }, "Send report"),
      h("button", { class: "btn link", onclick: () => { p.reportOpen = false; paint(); } }, "Cancel")));
});

K.settingsSections.push(() => h("div", { class: "card" },
  h("h2", { style: null }, "Your audience is yours"),
  h("p", { class: "muted small" }, "Download your followers, who you follow, and your posts as a JSON file."),
  h("button", { class: "btn", id: "export", onclick: act(async () => {
    const { data } = await api("GET", "/v1/social/me/export");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = h("a", { href: url, download: `kuyil-${data.handle}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }) }, "Download my data")));

route(/^\/about$/, () => [
  h("h1", {}, "What Kuyil promises"),
  h("p", {}, "Kuyil is the Malayalam name for the koel, a songbird. It's a place to build an audience that belongs to you."),
  h("h2", {}, "You own your audience"),
  h("p", {}, "You can download your followers and posts at any time from Settings."),
  h("h2", {}, "No hidden algorithm"),
  h("p", {}, "Following and Everything are in time order. Hot uses one public formula, and every post can show its own numbers: (2·tips + 1.5·replies + 1) ÷ (hours + 2)^1.5."),
  h("h2", {}, "You choose your filters"),
  h("p", {}, "Filters collapse a post and say why. Anyone can publish one."),
  h("h2", {}, "What gets removed"),
  h("p", {}, "Only content that's illegal: child sexual abuse material, credible threats, intimate images shared without consent, fraud, and what a court orders. Other posts aren't removed for being unpopular."),
  K.env !== "prod"
    ? h("h2", {}, "Money here is pretend")
    : h("h2", {}, "Payments aren't here yet"),
  h("p", {}, K.env !== "prod"
    ? "This is a test environment. Tips, subscriptions and deposits use test money, which can't be bought or withdrawn."
    : "Tips and subscriptions aren't available yet. Nothing on Kuyil can charge you."),
  h("p", {}, link("/economics", {}, "See how Kuyil plans to pay for itself")),
]);

route(/^\/economics$/, async () => {
  const { data } = await api("GET", "/v1/social/economics");
  const names = { tip: "Tips", creator_sub: "Subscriptions", curation_purchase: "Feeds and filters", verify: "Human checks", deposit_forfeit: "Forfeited spam deposits" };
  const rows = Object.entries(data.revenueMinor);
  return [
    h("h1", {}, "How Kuyil pays for itself"),
    h("p", { class: "muted" }, `Kuyil plans to keep ${data.feeBps / 100}% of tips, subscriptions and paid feeds, and ${data.forfeitCutBps / 100}% of a forfeited spam deposit. Ads aren't part of this version.`),
    h("div", { class: "stat-row" }, h("span", {}, h("strong", {}, data.accounts), " accounts"), h("span", {}, h("strong", {}, data.posts), " posts"), h("span", {}, h("strong", {}, rupees(data.totalMinor)), K.env === "prod" ? " earned" : " in test money")),
    rows.length ? h("table", {}, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("td", {}, names[k] || k), h("td", { class: "num" }, rupees(v)))))) : h("p", { class: "muted" }, "Nothing earned yet."),
  ];
});

route(/^\/admin\/reports$/, () => {
  if (!K.me) { requireSignIn(); return null; }
  const box = h("div");
  const paint = async () => {
    const { data } = await api("GET", "/v1/social/admin/reports");
    const label = Object.fromEntries(REASONS);
    fill(box, h("h1", {}, "Legal queue"),
      data.length ? data.map((r) => h("div", { class: "card" }, postCard(r.post, { main: true }),
        h("p", { class: "small" }, "Reported as: ", [...new Set(r.reports.map((x) => label[x.reason] || x.reason))].join(", ")),
        h("div", { class: "row" },
          h("button", { class: "btn danger", onclick: act(async () => { await api("POST", `/v1/social/admin/reports/${r.post.id}/resolve`, { decision: "removed", reason: "legal" }); await paint(); }) }, "Remove post"),
          h("button", { class: "btn", onclick: act(async () => { await api("POST", `/v1/social/admin/reports/${r.post.id}/resolve`, { decision: "kept" }); await paint(); }) }, "Keep post"))))
      : h("div", { class: "empty" }, "No open reports."));
  };
  return paint().then(() => box);
});
