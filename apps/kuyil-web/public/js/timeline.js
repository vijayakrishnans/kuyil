// KY2: sign-in, handle, home feed, thread, profile, follow, settings.
import { K, api, h, link, go, route, act, errorBox, toast, composer, postCard, setToken, getToken, loadMe, render, requireSignIn } from "./core.js";

K.homeTabs = () => (K.me ? [["following", "Following"], ["latest", "Everything"]] : [["latest", "Everything"]]);

export function feedList(feedId, { onEmpty } = {}) {
  const list = h("div", { "aria-live": "polite" });
  const more = h("div");
  const err = h("div");
  let cursor = null;
  const load = async () => {
    more.replaceChildren();
    try {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const r = await api("GET", `/v1/social/feeds/${feedId}${q}`);
      if (!cursor && !r.data.posts.length) list.append(h("div", { class: "empty" }, onEmpty || "Nothing here yet."));
      for (const p of r.data.posts) list.append(postCard(p));
      cursor = r.cursor;
      if (cursor) more.append(h("div", { class: "row", style: null }, h("button", { class: "btn", onclick: act(load) }, "Load more")));
    } catch (e) {
      err.replaceChildren(e.code === "payment_required"
        ? h("div", { class: "empty" }, e.message, " ", link("/feeds", {}, "See feeds"))
        : errorBox(e));
    }
  };
  load();
  return { el: h("div", {}, err, list, more), prepend: (p) => { list.querySelector(".empty")?.remove(); list.prepend(postCard(p)); } };
}

function hero() {
  return h("section", { class: "hero" },
    h("h1", {}, "Own your audience."),
    h("p", { class: "muted" }, "A short-post network where you choose what you see, every ranking is explained, and your followers go with you if you ever leave."),
    K.heroExtras.map((f) => f()),
    h("div", { class: "row" }, link("/login", { class: "btn primary" }, "Join Kuyil")),
  );
}

function home() {
  const tabs = K.homeTabs();
  const stored = K.activeFeed && tabs.some(([id]) => id === K.activeFeed) ? K.activeFeed : null;
  let active = stored || (K.me && tabs.some(([id]) => id === "following") ? "following" : tabs[0][0]);
  const panel = h("div");
  const bar = h("div", { class: "tabs", role: "tablist" });
  let feed;
  const show = () => {
    bar.replaceChildren(...tabs.map(([id, name]) => h("button", {
      role: "tab", "aria-selected": String(id === active), class: id === active ? "on" : null,
      onclick: () => { active = id; if (K.rememberFeed) K.rememberFeed(id); show(); },
    }, name)));
    feed = feedList(active, { onEmpty: active === "following" ? "Follow people to fill this feed. Try Everything." : "Nothing here yet. Say something first." });
    panel.replaceChildren(feed.el);
  };
  show();
  return [
    !K.me && hero(),
    K.me && composer({ onPosted: (p) => { if (active === "following" || active === "latest") feed.prepend(p); else toast("Posted."); } }),
    bar, panel,
  ];
}

route(/^\/$/, home);

route(/^\/login$/, () => {
  const next = new URLSearchParams(location.search).get("next") || "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const box = h("div", { class: "card" });
  const stepEmail = () => {
    const email = h("input", { type: "email", autocomplete: "email", required: true, placeholder: "you@example.com", id: "login-email" });
    const err = h("div");
    const submit = act(async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        const r = await api("POST", "/v1/auth/login/start", { email: email.value.trim() });
        stepCode(r.data);
      } catch (x) { err.replaceChildren(errorBox(x)); }
    });
    box.replaceChildren(h("form", { onsubmit: submit },
      h("label", { class: "field" }, h("span", {}, "Email"), email), err,
      h("button", { class: "btn primary", type: "submit" }, "Send code")));
    email.focus();
  };
  const stepCode = (start) => {
    const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, id: "login-code", value: start.delivery.code || "" });
    const err = h("div");
    const submit = act(async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        const r = await api("POST", "/v1/auth/login/complete", { challengeId: start.challengeId, code: code.value.trim() });
        setToken(r.data.token);
        await loadMe();
        go(K.me && !K.me.profile ? "/welcome" : safeNext);
      } catch (x) { err.replaceChildren(errorBox(x)); }
    });
    box.replaceChildren(h("form", { onsubmit: submit },
      start.delivery.code
        ? h("div", { class: "note" }, "Test environment: your code is already filled in.")
        : h("p", { class: "muted small" }, `We sent a code to ${start.delivery.emailHint}.`),
      h("label", { class: "field" }, h("span", {}, "6-digit code"), code), err,
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, "Sign in"), h("button", { class: "btn", type: "button", onclick: stepEmail }, "Use another email"))));
    code.focus();
  };
  stepEmail();
  return [h("h1", {}, "Sign in"), h("p", { class: "muted" }, "No password. We email you a one-time code."), box];
});

function profileForm({ initial, submitLabel, onDone }) {
  const handle = h("input", { type: "text", maxlength: 20, autocapitalize: "none", autocomplete: "username", value: initial.handle || "", id: "profile-handle", pattern: "[a-z0-9_]{2,20}" });
  const bio = h("textarea", { maxlength: 160, id: "profile-bio", value: initial.bio || "" });
  const err = h("div");
  return h("form", { class: "card", onsubmit: act(async (e) => {
    e.preventDefault(); err.replaceChildren();
    try {
      await api("PUT", "/v1/social/me/profile", { handle: handle.value.trim().toLowerCase(), bio: bio.value.trim(), subPriceMinor: initial.subPriceMinor || 500 });
      await loadMe();
      onDone();
    } catch (x) {
      const f = x.details && x.details.fields;
      err.replaceChildren(errorBox(f ? new Error(Object.values(f).join(" ")) : x));
    }
  }) },
    h("label", { class: "field" }, h("span", {}, "Handle"), handle, h("span", { class: "muted small", style: null }, "2–20 characters: a–z, 0–9, _")),
    h("label", { class: "field" }, h("span", {}, "Bio"), bio),
    err, h("button", { class: "btn primary", type: "submit" }, submitLabel));
}

route(/^\/welcome$/, () => {
  if (!K.me) { requireSignIn(); return null; }
  if (K.me.profile) { go("/"); return null; }
  return [h("h1", {}, "Pick your handle"), h("p", { class: "muted" }, "This is your name on Kuyil."),
    profileForm({ initial: {}, submitLabel: "Start posting", onDone: () => go("/") })];
});

K.settingsSections = [];
route(/^\/settings$/, () => {
  if (!K.me) { requireSignIn(); return null; }
  return [h("h1", {}, "Settings"),
    profileForm({ initial: K.me.profile, submitLabel: "Save", onDone: () => toast("Saved.") }),
    K.settingsSections.map((f) => f()),
    h("h2", {}, "Session"),
    h("button", { class: "btn", onclick: act(async () => {
      try { await api("POST", "/v1/auth/logout", undefined, { keepToken: true }); } catch { /* signing out locally still works */ }
      setToken(null); K.me = null; go("/");
    }) }, "Sign out")];
});

route(/^\/post\/(pst_[0-9a-f]{32})$/, async (id) => {
  const { data } = await api("GET", `/v1/social/posts/${id}`);
  const replies = h("div", {}, data.replies.map((p) => postCard(p)));
  const repliesTitle = h("h2", {}, data.replies.length ? "Replies" : "No replies yet");
  return [
    h("div", {}, data.ancestors.map((p) => postCard(p))),
    postCard(data.post, { main: true }),
    K.me && !data.post.locked ? composer({
      replyTo: id, placeholder: `Reply to @${data.post.author.handle}`,
      note: data.replyDepositMinor ? `@${data.post.author.handle} doesn't follow you, so this reply holds a refundable ₹${data.replyDepositMinor / 100} deposit. It comes back unless they flag it as spam.` : null,
      onPosted: (p) => { replies.append(postCard(p)); repliesTitle.textContent = "Replies"; },
    }) : !K.me && h("p", { class: "muted" }, link("/login", {}, "Sign in"), " to reply."),
    repliesTitle,
    replies,
  ];
});

route(/^\/@([a-z0-9_]{2,20})$/, async (handle) => {
  const { data, cursor } = await api("GET", `/v1/social/users/${handle}`);
  const mine = K.me && K.me.profile && K.me.profile.handle === handle;
  const followers = h("strong", {}, data.followers);
  let following = data.youFollow;
  const followBtn = !mine && h("button", { class: `btn ${following ? "" : "primary"}`, onclick: act(async (e) => {
    const btn = e.currentTarget;
    if (!K.me) return requireSignIn();
    await api(following ? "DELETE" : "PUT", `/v1/social/users/${handle}/follow`);
    following = !following;
    data.followers += following ? 1 : -1;
    followers.textContent = data.followers;
    btn.textContent = following ? "Following" : "Follow";
    btn.className = `btn ${following ? "" : "primary"}`;
    return undefined;
  }) }, following ? "Following" : "Follow");
  const list = h("div", {}, data.posts.map((p) => postCard(p)));
  let next = cursor;
  const more = h("div");
  const paintMore = () => more.replaceChildren(...(next ? [h("button", { class: "btn", onclick: act(async () => {
    const r = await api("GET", `/v1/social/users/${handle}?cursor=${encodeURIComponent(next)}`);
    for (const p of r.data.posts) list.append(postCard(p));
    next = r.cursor; paintMore();
  }) }, "Load more")] : []));
  paintMore();
  return [
    h("div", { class: "hero" },
      h("div", { class: "row" }, h("h1", { class: "grow" }, `@${data.handle}`, data.verified && h("span", { class: "tick" }, " ✓ human")), followBtn),
      data.bio && h("p", {}, data.bio),
      h("div", { class: "stat-row muted" }, h("span", {}, followers, " followers"), h("span", {}, h("strong", {}, data.following), " following"), data.followsYou && h("span", { class: "chip" }, "follows you")),
      K.profileExtras.map((f) => f(data, mine)),
    ),
    list.childElementCount ? null : h("div", { class: "empty" }, "No posts yet."),
    list, more,
  ];
});

export { getToken, render };
