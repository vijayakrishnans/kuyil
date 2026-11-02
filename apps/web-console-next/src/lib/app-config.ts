// Instance identity for the web console (saas-bootstrap-factory BF3 seam).
//
// Branding strings, deployment hostnames, contact addresses, and storage-key
// namespaces live here so a new instance of the starter retargets one file.
// Do not add behavior — values and trivial derivations only.
//
// RUNTIME, NOT BUILD (saas-console-artifact CA1). Every value below can be
// overridden per request by the Worker's `vars` (wrangler.jsonc), which the
// OpenNext runtime copies into `process.env`. So ONE build of the console can
// serve any product and any environment: the root layout resolves the config
// on the server and hands it to the client through <Providers config>. The
// constants are the fallback — what a deploy with no `vars` gets — and they
// keep their old exported names on purpose: `PRODUCT_NAME = "Kuyil"` and
// `STORAGE_PREFIX = "kuyil.next"` are literal seams tooling/rebrand/rebrand.mjs
// matches, so a fork's identity still lands here with no change to the rebrand.

/** Product/brand name shown across the console. */
export const PRODUCT_NAME = "Kuyil";

/** Marketing-facing product description (document metadata). */
export const PRODUCT_DESCRIPTION =
  "Next-gen control plane for your projects, environments, and entitlements.";

/** The Cloudflare account's workers.dev subdomain serving this instance. */
export const WORKERS_DEV_SUBDOMAIN = "vijayakrishnan12994";

/** api-edge worker name without its `-<env>` suffix (rebrand: worker CF name). */
export const API_WORKER_PREFIX = "kuyil-api-edge";

/** Sales contact surfaced by the billing upgrade UX. */
export const SALES_EMAIL = "sales@sourceplane.ai";

/** Namespace prefix for console localStorage keys. */
export const STORAGE_PREFIX = "kuyil.next";

export interface AppConfig {
  productName: string;
  productDescription: string;
  workersDevSubdomain: string;
  apiWorkerPrefix: string;
  storagePrefix: string;
  salesEmail: string;
  /** The single environment this deploy serves; unset offers every target. */
  deployEnv: string | undefined;
}

// `process.env.NEXT_PUBLIC_DEPLOY_ENV` is inlined at build time where it is
// still set. The local declaration lets the node-types-free test compiler read
// this file; it shadows harmlessly under the app build.
declare const process: { env: Record<string, string | undefined> } | undefined;

const BUILD_DEPLOY_ENV: string | undefined =
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DEPLOY_ENV || undefined : undefined;

/** This tree's own identity: what a deploy with no runtime `vars` serves. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  productName: PRODUCT_NAME,
  productDescription: PRODUCT_DESCRIPTION,
  workersDevSubdomain: WORKERS_DEV_SUBDOMAIN,
  apiWorkerPrefix: API_WORKER_PREFIX,
  storagePrefix: STORAGE_PREFIX,
  salesEmail: SALES_EMAIL,
  deployEnv: BUILD_DEPLOY_ENV,
};

/** The Worker `vars` that override each field at runtime. */
export const RUNTIME_KEYS: Record<keyof AppConfig, string> = {
  productName: "CONSOLE_PRODUCT_NAME",
  productDescription: "CONSOLE_PRODUCT_DESCRIPTION",
  workersDevSubdomain: "CONSOLE_WORKERS_DEV_SUBDOMAIN",
  apiWorkerPrefix: "CONSOLE_API_WORKER_PREFIX",
  storagePrefix: "CONSOLE_STORAGE_PREFIX",
  salesEmail: "CONSOLE_SALES_EMAIL",
  deployEnv: "CONSOLE_DEPLOY_ENV",
};

/** The environments a console deploy can be locked to: the API targets. */
export const DEPLOY_ENVIRONMENTS = ["stage", "prod"] as const;

/**
 * The environment a request's host names, by the Worker naming every console
 * deploy follows (`<worker>-<env>.<subdomain>.workers.dev`): the first label's
 * last `-` segment, when that is a known environment. A custom domain names
 * none, and its deploy sets CONSOLE_DEPLOY_ENV instead.
 */
export function environmentFromHost(host: string | null | undefined): string | undefined {
  const label = (host ?? "").toLowerCase().split(":")[0]!.split(".")[0]!;
  const suffix = label.slice(label.lastIndexOf("-") + 1);
  return label.includes("-") && (DEPLOY_ENVIRONMENTS as readonly string[]).includes(suffix) ? suffix : undefined;
}

/**
 * The config for one request: each field from its runtime var when that is a
 * non-empty string, else the default. The deploy environment falls back
 * further, to the one the request's host names (saas-console-artifact CA2), so
 * one build serves every environment without being told which at build time.
 * Pure, so it is unit-testable.
 */
export function resolveAppConfig(
  env: Record<string, string | undefined>,
  defaults: AppConfig = DEFAULT_APP_CONFIG,
  host?: string | null,
): AppConfig {
  const pick = (key: keyof AppConfig): string | undefined => {
    const value = env[RUNTIME_KEYS[key]];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  return {
    productName: pick("productName") ?? defaults.productName,
    productDescription: pick("productDescription") ?? defaults.productDescription,
    workersDevSubdomain: pick("workersDevSubdomain") ?? defaults.workersDevSubdomain,
    apiWorkerPrefix: pick("apiWorkerPrefix") ?? defaults.apiWorkerPrefix,
    storagePrefix: pick("storagePrefix") ?? defaults.storagePrefix,
    salesEmail: pick("salesEmail") ?? defaults.salesEmail,
    deployEnv: pick("deployEnv") ?? defaults.deployEnv ?? environmentFromHost(host),
  };
}

let current: AppConfig = DEFAULT_APP_CONFIG;
let serverHost: string | null = null;

/**
 * Record the host the server is answering on (the root layout calls this per
 * request). Every console Worker serves one environment, so every request an
 * isolate sees names the same one: concurrent requests cannot disagree.
 */
export function rememberRequestHost(host: string | null): void {
  if (host) serverHost = host;
}

/**
 * The config in force. On the server it is resolved from the request's
 * environment (and the host the layout recorded) on every call, so a server
 * component never depends on the root layout having rendered first. In the
 * browser it is what <Providers> installed from the layout's resolution.
 */
export function appConfig(): AppConfig {
  if (typeof window === "undefined" && typeof process !== "undefined") {
    return resolveAppConfig(process.env, DEFAULT_APP_CONFIG, serverHost);
  }
  return current;
}

/** Install the resolved config in the browser. Idempotent; called by <Providers> on render. */
export function setAppConfig(config: AppConfig): void {
  current = config;
}

/** Browser/document title of the console. */
export function consoleTitle(config: AppConfig = appConfig()): string {
  return `${config.productName} Console`;
}

/** api-edge workers.dev URL for a given environment name. */
export function apiEdgeWorkersDevUrl(environment: string, config: AppConfig = appConfig()): string {
  return `https://${config.apiWorkerPrefix}-${environment}.${config.workersDevSubdomain}.workers.dev`;
}
