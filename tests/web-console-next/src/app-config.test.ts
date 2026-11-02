import {
  DEFAULT_APP_CONFIG,
  RUNTIME_KEYS,
  apiEdgeWorkersDevUrl,
  consoleTitle,
  environmentFromHost,
  resolveAppConfig,
  type AppConfig,
} from "@web-console-next/lib/app-config";
import { apiTargets, deployEnv, isLocked } from "@web-console-next/lib/api";

// saas-console-artifact CA1: one console build serves any product, because the
// product's identity comes from the Worker's `vars` at runtime.

const acme: Record<string, string> = {
  CONSOLE_PRODUCT_NAME: "Acme Cloud",
  CONSOLE_WORKERS_DEV_SUBDOMAIN: "acme-inc",
  CONSOLE_API_WORKER_PREFIX: "acme-cloud-api-edge",
  CONSOLE_STORAGE_PREFIX: "acme-cloud.next",
};

describe("resolveAppConfig", () => {
  it("with no vars is exactly the compiled-in identity", () => {
    expect(resolveAppConfig({})).toEqual(DEFAULT_APP_CONFIG);
  });

  it("takes each field from its runtime var", () => {
    const cfg = resolveAppConfig({ ...acme, CONSOLE_SALES_EMAIL: "sales@acme.dev", CONSOLE_DEPLOY_ENV: "stage" });
    expect(cfg).toEqual({
      productName: "Acme Cloud",
      productDescription: DEFAULT_APP_CONFIG.productDescription,
      workersDevSubdomain: "acme-inc",
      apiWorkerPrefix: "acme-cloud-api-edge",
      storagePrefix: "acme-cloud.next",
      salesEmail: "sales@acme.dev",
      deployEnv: "stage",
    });
  });

  it("ignores empty and blank vars", () => {
    expect(resolveAppConfig({ CONSOLE_PRODUCT_NAME: "", CONSOLE_STORAGE_PREFIX: "  " })).toEqual(DEFAULT_APP_CONFIG);
  });

  it("never reads a NEXT_PUBLIC_ name, which Next would have inlined at build", () => {
    for (const key of Object.values(RUNTIME_KEYS)) expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});

describe("derivations follow the runtime config", () => {
  const cfg: AppConfig = resolveAppConfig(acme);

  it("builds the product's api-edge URL and title", () => {
    expect(apiEdgeWorkersDevUrl("prod", cfg)).toBe("https://acme-cloud-api-edge-prod.acme-inc.workers.dev");
    expect(consoleTitle(cfg)).toBe("Acme Cloud Console");
  });

  it("offers both targets when no deploy env is set", () => {
    const unlocked = { ...cfg, deployEnv: undefined };
    expect(apiTargets(unlocked).map((t) => t.url)).toEqual([
      "https://acme-cloud-api-edge-stage.acme-inc.workers.dev",
      "https://acme-cloud-api-edge-prod.acme-inc.workers.dev",
    ]);
    expect(isLocked(unlocked)).toBe(false);
  });

  it("locks to the deploy env when one is set at runtime", () => {
    const locked = resolveAppConfig({ ...acme, CONSOLE_DEPLOY_ENV: "prod" });
    expect(deployEnv(locked)).toBe("prod");
    expect(apiTargets(locked)).toEqual([{ name: "prod", url: "https://acme-cloud-api-edge-prod.acme-inc.workers.dev" }]);
    expect(isLocked(locked)).toBe(true);
  });
});

// saas-console-artifact CA2: the deploy environment is not compiled in; a
// console Worker learns it from CONSOLE_DEPLOY_ENV or from its own host.
describe("environmentFromHost", () => {
  it("reads the -<env> suffix of a console Worker's workers.dev host", () => {
    expect(environmentFromHost("kuyil-web-console-next-stage.vijayakrishnan12994.workers.dev")).toBe("stage");
    expect(environmentFromHost("acme-cloud-web-console-next-prod.acme-inc.workers.dev:443")).toBe("prod");
  });

  it("names nothing for an unknown suffix, a custom domain, or no host", () => {
    expect(environmentFromHost("acme-cloud-web-console-next-dev.acme-inc.workers.dev")).toBeUndefined();
    expect(environmentFromHost("console.acme.dev")).toBeUndefined();
    expect(environmentFromHost("prod.acme.dev")).toBeUndefined();
    expect(environmentFromHost("127.0.0.1:8787")).toBeUndefined();
    expect(environmentFromHost(null)).toBeUndefined();
  });

  it("is the last resort: the var, then a compiled-in env, then the host", () => {
    const host = "x-web-console-next-prod.acme-inc.workers.dev";
    const unbuilt = { ...DEFAULT_APP_CONFIG, deployEnv: undefined };
    expect(resolveAppConfig({}, unbuilt, host).deployEnv).toBe("prod");
    expect(resolveAppConfig({ CONSOLE_DEPLOY_ENV: "stage" }, unbuilt, host).deployEnv).toBe("stage");
    expect(resolveAppConfig({}, { ...unbuilt, deployEnv: "stage" }, host).deployEnv).toBe("stage");
    expect(isLocked(resolveAppConfig({}, unbuilt, host))).toBe(true);
    expect(isLocked(resolveAppConfig({}, unbuilt, "console.acme.dev"))).toBe(false);
  });
});
