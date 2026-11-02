import type { Env } from "./env.js";
import { errorResponse } from "./http.js";
import { replayOrExecute } from "./idempotency.js";
import { resolveActor } from "./resolve-actor.js";

// Kuyil social surface: /v1/social/**  →  SOCIAL_WORKER.
//
// Reads are public — a social network that can only be read signed-in is not
// one — so a GET without an Authorization header is forwarded anonymously.
// A GET WITH a header must still resolve (a bad token is a 401, not a silent
// downgrade to anonymous). Every write needs a session.
const SOCIAL_RE = /^\/v1\/social(\/.*)?$/;

const FORWARDED_HEADERS = ["content-type", "traceparent", "idempotency-key"];

export function isSocialRoute(pathname: string): boolean {
  return SOCIAL_RE.test(pathname);
}

export async function handleSocialRoute(
  request: Request,
  env: Env,
  requestId: string,
  pathname: string,
): Promise<Response> {
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) {
    return errorResponse("unsupported", "Method not allowed", 405, requestId);
  }

  return replayOrExecute(request, requestId, env, "social", async () => {
    if (!env.SOCIAL_WORKER) {
      return errorResponse("internal_error", "Social service unavailable", 503, requestId);
    }

    const headers = new Headers();
    headers.set("x-request-id", requestId);

    const anonymousRead = request.method === "GET" && !request.headers.get("authorization");
    if (!anonymousRead) {
      if (!env.IDENTITY_WORKER) {
        return errorResponse("internal_error", "Authentication service unavailable", 503, requestId);
      }
      const actor = await resolveActor(request, env, requestId);
      if ("error" in actor) return actor.error;
      headers.set("x-actor-subject-id", actor.subjectId);
      headers.set("x-actor-subject-type", actor.subjectType);
    }
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const url = new URL(request.url);
    const target = new URL(pathname + url.search, "https://social.internal");
    try {
      const init: RequestInit = { method: request.method, headers };
      if (request.method === "POST" || request.method === "PUT") init.body = request.body;
      const downstream = await env.SOCIAL_WORKER.fetch(target.toString(), init);
      return new Response(downstream.body, { status: downstream.status, headers: downstream.headers });
    } catch {
      return errorResponse("internal_error", "Social service unavailable", 503, requestId);
    }
  });
}
