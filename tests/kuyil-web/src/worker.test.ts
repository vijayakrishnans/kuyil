import worker, { isApiPath, type Env } from "@kuyil-web/index";

const env = (over: Partial<Env> = {}): Env => ({
  ENVIRONMENT: "stage",
  ASSETS: { fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher,
  API: { fetch: async (r: Request) => Response.json({ path: new URL(r.url).pathname, origin: r.headers.get("origin"), auth: r.headers.get("authorization"), method: r.method }) } as unknown as Fetcher,
  ...over,
});
const call = (path: string, init?: RequestInit, e = env()) => worker.fetch(new Request("https://kuyil.test" + path, init), e);

describe("routing", () => {
  it("treats only /v1 paths as API", () => {
    expect(isApiPath("/v1/social/me")).toBe(true);
    expect(isApiPath("/v1")).toBe(true);
    expect(isApiPath("/v12")).toBe(false);
    expect(isApiPath("/@v1")).toBe(false);
  });
  it("forwards API calls with credentials but without the browser's origin", async () => {
    const res = await call("/v1/social/posts", { method: "POST", body: "{}", headers: { origin: "https://evil.test", authorization: "Bearer t" } });
    expect(await res.json()).toEqual({ path: "/v1/social/posts", origin: null, auth: "Bearer t", method: "POST" });
  });
  it("answers 503 when the API binding is missing", async () => {
    const noApi = { ENVIRONMENT: "stage", ASSETS: env().ASSETS } as Env;
    expect((await call("/v1/x", undefined, noApi)).status).toBe(503);
  });
  it("serves its own health route", async () => {
    expect(await (await call("/healthz")).json()).toEqual({ status: "ok", environment: "stage" });
  });
});

describe("pages", () => {
  it("carry a strict content security policy", async () => {
    const res = await call("/@anu");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
