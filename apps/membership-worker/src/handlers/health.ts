import type { Env } from "../env.js";
import { createHyperdriveAdapter } from "@saas/db/hyperdrive";

export async function handleHealth(env: Env, _requestId: string): Promise<Response> {
  const db = await checkDatabase(env);

  return Response.json(
    {
      status: db.configured && !db.reachable ? "degraded" : "ok",
      service: "membership-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      checks: { database: db },
    },
    { status: db.configured && !db.reachable ? 503 : 200 },
  );
}

async function checkDatabase(
  env: Env,
): Promise<{ configured: boolean; reachable: boolean }> {
  if (!env.PLATFORM_DB) {
    return { configured: false, reachable: false };
  }

  const adapter = createHyperdriveAdapter(env.PLATFORM_DB);
  try {
    return await adapter.ping();
  } finally {
    await adapter.dispose();
  }
}
