import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";
import * as h from "./handlers.js";
import { errorResponse, generateRequestId, json, parsePub } from "./http.js";

const RID_RE = /^[\w-]{1,128}$/;

type Handler = (ctx: h.Ctx, ...params: string[]) => Promise<Response>;
const routes: Array<[string, RegExp, Handler]> = [
  ["GET", /^\/v1\/social\/me$/, h.getMe],
  ["PUT", /^\/v1\/social\/me\/profile$/, h.putProfile],
  ["PUT", /^\/v1\/social\/me\/prefs$/, h.putPrefs],
  ["POST", /^\/v1\/social\/me\/verify$/, h.verify],
  ["GET", /^\/v1\/social\/me\/wallet$/, h.getWallet],
  ["POST", /^\/v1\/social\/me\/wallet\/dev-topup$/, h.devTopUp],
  ["GET", /^\/v1\/social\/me\/export$/, h.exportMe],
  ["GET", /^\/v1\/social\/feeds\/([\w]+)$/, h.getFeed],
  ["POST", /^\/v1\/social\/posts$/, h.createPost],
  ["GET", /^\/v1\/social\/posts\/(pst_[0-9a-f]{32})$/, h.getThread],
  ["POST", /^\/v1\/social\/posts\/(pst_[0-9a-f]{32})\/tips$/, h.tipPost],
  ["POST", /^\/v1\/social\/posts\/(pst_[0-9a-f]{32})\/reports$/, h.reportPost],
  ["POST", /^\/v1\/social\/deposits\/(pst_[0-9a-f]{32})\/refund$/, (c, id) => h.settleDeposit(c, id!, "refund")],
  ["POST", /^\/v1\/social\/deposits\/(pst_[0-9a-f]{32})\/forfeit$/, (c, id) => h.settleDeposit(c, id!, "forfeit")],
  ["GET", /^\/v1\/social\/users\/([a-z0-9_]{2,20})$/, h.getUser],
  ["PUT", /^\/v1\/social\/users\/([a-z0-9_]{2,20})\/follow$/, (c, u) => h.setFollow(c, u!, true)],
  ["DELETE", /^\/v1\/social\/users\/([a-z0-9_]{2,20})\/follow$/, (c, u) => h.setFollow(c, u!, false)],
  ["POST", /^\/v1\/social\/users\/([a-z0-9_]{2,20})\/subscribe$/, h.subscribe],
  ["GET", /^\/v1\/social\/curations$/, h.listCurations],
  ["POST", /^\/v1\/social\/curations$/, h.createCuration],
  ["DELETE", /^\/v1\/social\/curations\/(cur_[0-9a-f]{32})$/, h.deleteCuration],
  ["POST", /^\/v1\/social\/curations\/(cur_[0-9a-f]{32})\/purchase$/, h.purchaseCuration],
  ["GET", /^\/v1\/social\/admin\/reports$/, h.listReports],
  ["POST", /^\/v1\/social\/admin\/reports\/(pst_[0-9a-f]{32})\/resolve$/, h.resolveReport],
  ["GET", /^\/v1\/social\/economics$/, h.economics],
];

export async function route(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("x-request-id");
  const rid = header && RID_RE.test(header) ? header : generateRequestId();
  const url = new URL(request.url);

  if (url.pathname === "/v1/social/health") return json({ status: "ok", environment: env.ENVIRONMENT, db: !!env.PLATFORM_DB }, rid);

  let match: { handler: Handler; params: string[] } | null = null;
  let pathKnown = false;
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    pathKnown = true;
    if (method === request.method) { match = { handler, params: m.slice(1) }; break; }
  }
  if (!match) {
    return pathKnown
      ? errorResponse("unsupported", "Method not allowed", 405, rid)
      : errorResponse("not_found", `Route not found: ${url.pathname}`, 404, rid);
  }
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Service unavailable", 503, rid);

  // api-edge resolves the session and forwards the subject; only users act.
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  const viewer = subjectType === "user" ? parsePub("usr", subjectId) : null;

  const ex = createSqlExecutor(env.PLATFORM_DB);
  try {
    return await match.handler({ env, rid, request, url, ex, viewer }, ...match.params);
  } catch (e) {
    const mapped = h.walletErrorResponse(e, rid);
    if (mapped) return mapped;
    console.error(JSON.stringify({ level: "error", msg: "social.unhandled", requestId: rid, path: url.pathname, error: String(e) }));
    return errorResponse("internal_error", "Something went wrong", 500, rid);
  } finally {
    await ex.dispose();
  }
}
