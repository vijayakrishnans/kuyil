// Kuyil's public app: static files from ./public, and /v1/* passed to api-edge
// over a service binding. Same origin, so the browser needs no CORS and the
// content security policy can stay strict.
export interface Env {
  API?: Fetcher;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

export function isApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      if (!env.API) {
        return Response.json(
          { error: { code: "internal_error", message: "API unavailable", details: {}, requestId: "" } },
          { status: 503 },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("origin");
      return env.API.fetch(new Request(request, { headers, redirect: "manual" }));
    }
    if (url.pathname === "/healthz") return Response.json({ status: "ok", environment: env.ENVIRONMENT });
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;
