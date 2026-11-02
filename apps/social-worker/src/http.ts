import { uuidToHex, hexToUuid } from "@saas/db/ids";

export function json<T>(data: T, requestId: string, status = 200, cursor: string | null = null): Response {
  return Response.json({ data, meta: { requestId, cursor } }, { status, headers: { "content-type": "application/json" } });
}

export function errorResponse(code: string, message: string, status: number, requestId: string, details?: Record<string, unknown>): Response {
  return Response.json({ error: { code, message, details: details ?? {}, requestId } }, { status, headers: { "content-type": "application/json" } });
}

export const notFound = (rid: string, what = "Not found") => errorResponse("not_found", what, 404, rid);
export const unauthenticated = (rid: string) => errorResponse("unauthenticated", "Sign in to do that", 401, rid);
export const forbidden = (rid: string, msg = "Not allowed") => errorResponse("forbidden", msg, 403, rid);
export const validation = (rid: string, fields: Record<string, string>) =>
  errorResponse("validation_failed", "Validation failed", 422, rid, { fields });

export function generateRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return "req_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Public ids: usr_ (identity user), pst_ (post), cur_ (curation).
export const pub = (prefix: "usr" | "pst" | "cur", uuid: string) => `${prefix}_${uuidToHex(uuid)}`;
export function parsePub(prefix: "usr" | "pst" | "cur", id: string | undefined | null): string | null {
  if (!id || !id.startsWith(prefix + "_")) return null;
  return hexToUuid(id.slice(prefix.length + 1));
}
/** A feed/filter id is either a built-in slug or a cur_ public id. */
export function parseCurationRef(id: string): { builtin: string } | { uuid: string } | null {
  if (/^[a-z_]{2,20}$/.test(id) && !id.startsWith("cur_")) return { builtin: id };
  const u = parsePub("cur", id);
  return u ? { uuid: u } : null;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const v = await request.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function encodeCursor(createdAt: string | Date, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return btoa(`${iso}|${id}`).replace(/=+$/, "");
}
export function decodeCursor(raw: string | null): { createdAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const [createdAt, id] = atob(raw).split("|");
    if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
