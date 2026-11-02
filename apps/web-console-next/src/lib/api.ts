// Console-side glue for `@saas/sdk` (Task 0104).
//
// The hand-rolled fetch/decode/envelope client that used to live here was
// deleted; all wire I/O now goes through the typed `Kuyil` resource
// clients in `@saas/sdk`. This file keeps only what is intrinsically a
// console concern:
//
//   - `ApiTarget` / `apiTargets` / `deployEnv` / `isLocked` — the multi-target
//     switcher the console exposes for stage/prod parity testing. The SDK
//     deliberately doesn't carry "which environment am I pointed at",
//     because that's a deployment-shape decision.
//   - `createClient` — constructs a `Kuyil` against a target, wired
//     to a bearer token (or none).
//   - `ApiResult<T>` / `ApiErrorBody` / `wrap` — the result-envelope shape
//     `useAsync` and the precondition-failed UX consume. `wrap` adapts a
//     `Promise<T>` + thrown `KuyilError` into the same shape the
//     old hand-rolled client produced, so call-site ergonomics are
//     unchanged. NO route strings, NO header building, NO JSON decoding
//     happens here — that all comes from the SDK.

import { Kuyil, KuyilError, type ClientOptions } from "@saas/sdk";
import { DEPLOY_ENVIRONMENTS, apiEdgeWorkersDevUrl, appConfig, type AppConfig } from "./app-config";

export type ApiClient = Kuyil;

export interface ApiTarget {
  name: string;
  url: string;
}

// FUNCTIONS, NOT CONSTS (saas-console-artifact CA1/CA2). These used to be
// module-level constants, evaluated once at import from a build-time
// NEXT_PUBLIC_DEPLOY_ENV — which is exactly what stopped one build of the
// console from serving both environments. They now read the config in force
// for the request.

/** Every API target this console can talk to, under the config in force. */
export function allTargets(config: AppConfig = appConfig()): ApiTarget[] {
  return DEPLOY_ENVIRONMENTS.map((name) => ({ name, url: apiEdgeWorkersDevUrl(name, config) }));
}

/** The single environment this deploy serves, when it is locked to one. */
export function deployEnv(config: AppConfig = appConfig()): string | undefined {
  return config.deployEnv;
}

/** The targets the user may pick: only the deploy's own when it is locked. */
export function apiTargets(config: AppConfig = appConfig()): ApiTarget[] {
  const env = deployEnv(config);
  const all = allTargets(config);
  return env ? all.filter((t) => t.name === env) : all;
}

/** True when this deploy serves exactly one environment (no target switcher). */
export function isLocked(config: AppConfig = appConfig()): boolean {
  return apiTargets(config).length === 1 && !!deployEnv(config);
}

export interface ApiErrorBody {
  code: string;
  message: string;
  reason?: string | undefined;
  details?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
}

export type ApiResult<T> =
  | { ok: true; data: T; meta: { requestId: string; cursor: string | null } }
  | { ok: false; error: ApiErrorBody; status: number };

export function createClient(target: ApiTarget, token: string | null): Kuyil {
  const opts: ClientOptions = { baseUrl: target.url };
  if (token) opts.auth = { kind: "bearer", token };
  return new Kuyil(opts);
}

/**
 * Adapt an SDK promise into the `ApiResult<T>` envelope. Typed
 * `KuyilError` subclasses surface as `{ ok: false }` carrying the
 * same `code`/`message`/`reason`/`details`/`requestId` fields the
 * precondition-failed insight UX depends on. Network errors collapse to
 * `code: "network_error"` to match the old shape.
 */
export async function wrap<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, meta: { requestId: "", cursor: null } };
  } catch (e) {
    if (e instanceof KuyilError) {
      const body: ApiErrorBody = {
        code: e.code,
        message: e.message,
        details: e.details,
        requestId: e.requestId,
      };
      const reason = e.details["reason"];
      if (typeof reason === "string") body.reason = reason;
      return { ok: false, status: e.status, error: body };
    }
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: (e as Error).message ?? "network unreachable",
      },
    };
  }
}
