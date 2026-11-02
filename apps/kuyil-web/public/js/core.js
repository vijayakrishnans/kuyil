// Kuyil's core: API client, DOM builder, router and session. All user text goes
// through textContent (see h), never innerHTML, so a post cannot inject markup.
export const K = {
  me: null, env: null, routes: [], navLinks: [], postActions: [], postDecorators: [], composerExtras: [],
  profileExtras: [], homeTabs: null, heroExtras: [], onMe: [],
};

const TOKEN_KEY = "kuyil.token";
export function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode: session lasts this page only */ }
}

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details || {}; }
}

export async function api(method, path, body, opts = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotent) headers["idempotency-key"] = crypto.randomUUID();
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* an empty or non-JSON body becomes the error below */ }
  if (!res.ok) {
    const e = json && json.error;
    if (res.status === 401 && token && !opts.keepToken) { setToken(null); K.me = null; }
    throw new ApiError(res.status, e ? e.code : "error", e ? e.message : "Something went wrong. Try again.", e && e.details);
  }
  if (!json) throw new ApiError(res.status, "bad_response", "The server sent an unreadable response. Try again.");
  return { data: json.data, cursor: json.meta ? json.meta.cursor : null };
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's contents, flattening nested lists and dropping empties. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== undefined && c !== null && c !== false));
}

export function link(href, attrs, ...children) {
  return h("a", { ...attrs, href, onclick: (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault(); go(href);
  } }, ...children);
}

export function go(path) { history.pushState(null, "", path); render(); }

export const rupees = (minor) => `₹${(minor / 100).toLocaleString("en-IN", minor % 100 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {})}`;

export function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

let toastTimer;
export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

export function errorBox(e) { return h("p", { class: "error", role: "alert" }, e.message || String(e)); }

/** Run an action from a button: disables it while running, and reports failure. */
export function act(fn) {
  return async (e) => {
    const btn = e && e.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(e); } catch (err) { toast(err.message || "Something went wrong."); }
    finally { if (btn) btn.disabled = false; }
  };
}

export function requireSignIn() { go(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); }

export async function loadMe() {
  if (!getToken()) { K.me = null; return null; }
  try { K.me = (await api("GET", "/v1/social/me")).data; }
  catch (e) { if (e.status === 401) K.me = null; else throw e; }
  for (const f of K.onMe) await f(K.me);
  return K.me;
}

export function needsProfile() { return K.me && !K.me.profile; }

// ── post card ───────────────────────────────────────────────
export function postCard(p, opts = {}) {
  const wrap = h("article", { class: `post${opts.main ? " main" : ""}`, "data-post": p.id });
  const head = h("div", { class: "post-head" },
    link(`/@${p.author.handle}`, {}, `@${p.author.handle}`),
    p.author.verified && h("span", { class: "tick", title: "Verified human" }, "✓ human"),
    h("span", { class: "muted small" }, "· ", link(`/post/${p.id}`, { class: "muted", style: null }, h("time", { datetime: p.createdAt }, ago(p.createdAt)))),
    p.subscribersOnly && h("span", { class: "chip" }, "subscribers"),
    p.labels.map((l) => h("span", { class: "chip" }, l)),
  );
  wrap.append(head);

  const content = h("div");
  const paint = () => {
    content.replaceChildren();
    if (p.locked) {
      content.append(h("div", { class: "locked" }, `Subscribers only. Subscribe to @${p.author.handle} on their profile to read this.`));
    } else {
      content.append(h("div", { class: "post-body" }, p.body));
    }
    for (const d of K.postDecorators) { const x = d(p, wrap); if (x) content.append(x); }
    const actions = h("div", { class: "post-actions" },
      link(`/post/${p.id}`, { class: "btn link" }, p.replies ? `Reply · ${p.replies}` : "Reply"),
      K.postActions.map((a) => a(p, paint)),
    );
    content.append(actions);
  };
  if (p.hidden && !opts.main) {
    const collapsed = h("div", { class: "collapsed" },
      `Hidden by your filter “${p.hidden.name}”: ${p.hidden.reason}. `,
      h("button", { class: "btn link", onclick: () => { collapsed.remove(); wrap.append(content); paint(); } }, "Show anyway"));
    wrap.append(collapsed);
  } else {
    wrap.append(content); paint();
  }
  return wrap;
}

// ── composer ────────────────────────────────────────────────
export function composer({ replyTo = null, placeholder = "What's happening?", onPosted, note = null }) {
  const text = h("textarea", { placeholder, maxlength: 500, "aria-label": placeholder });
  const extras = K.composerExtras.map((f) => f({ replyTo }));
  const err = h("div");
  const count = h("span", { class: "muted small" }, "0 / 500");
  text.addEventListener("input", () => { count.textContent = `${text.value.length} / 500`; });
  const send = h("button", { class: "btn primary", onclick: act(async () => {
    err.replaceChildren();
    const body = text.value.trim();
    if (!body) return;
    const payload = { body, replyTo: replyTo || undefined };
    for (const x of extras) if (x.collect) Object.assign(payload, x.collect());
    try {
      const r = await api("POST", "/v1/social/posts", payload);
      if (text.value.trim() === body) { text.value = ""; count.textContent = "0 / 500"; }
      for (const x of extras) if (x.reset) x.reset();
      if (r.data.depositMinor) toast(`Posted. ${rupees(r.data.depositMinor)} deposit held until they respond.`);
      onPosted(r.data.post);
    } catch (e) {
      err.replaceChildren(errorBox(e.code === "insufficient_funds" ? new Error("You need test money in your wallet for this reply's deposit.") : e));
    }
  }) }, replyTo ? "Reply" : "Post");
  return h("div", { class: "composer" }, note && h("div", { class: "note" }, note), text,
    extras.map((x) => x.el), err,
    h("div", { class: "row", style: null }, count, h("span", { class: "grow" }), send));
}

// ── router ──────────────────────────────────────────────────
export function route(pattern, view) { K.routes.push({ pattern, view }); }

const root = () => document.getElementById("app");

function topBar() {
  const here = currentPath();
  const nav = (href, label) => link(href, { class: here === href ? "on" : null }, label);
  return h("header", { class: "top" },
    K.env && K.env !== "prod" && h("div", { class: "banner" }, `Test environment (${K.env}). Sign-in codes appear on screen and money is pretend.`),
    h("div", { class: "top-in" },
      link("/", { class: "brand" }, h("img", { src: "/favicon.svg", alt: "" }), "Kuyil"),
      h("nav", { class: "nav", "aria-label": "Main" },
        K.navLinks.map((l) => l(nav)),
        K.me && K.me.profile ? [nav(`/@${K.me.profile.handle}`, "Profile"), nav("/settings", "Settings")] : !K.me && nav("/login", "Sign in"),
      )));
}

/** The decoded path: Cloudflare's asset layer redirects /@name to /%40name. */
function currentPath() {
  try { return decodeURIComponent(location.pathname); } catch { return location.pathname; }
}

let renderId = 0;
export async function render() {
  const id = ++renderId;
  const path = currentPath();
  const main = h("main");
  root().replaceChildren(topBar(), main);
  if (needsProfile() && path !== "/welcome" && path !== "/login") { history.replaceState(null, "", "/welcome"); return render(); }
  for (const r of K.routes) {
    const m = path.match(r.pattern);
    if (!m) continue;
    try {
      const out = await r.view(...m.slice(1));
      if (id === renderId) fill(main, out);
    } catch (e) {
      if (id === renderId) main.replaceChildren(h("div", { class: "empty" }, e.status === 404 ? "That isn't here." : errorBox(e)));
    }
    window.scrollTo(0, 0);
    return;
  }
  main.replaceChildren(h("div", { class: "empty" }, "That page doesn't exist."));
}

window.addEventListener("popstate", render);
