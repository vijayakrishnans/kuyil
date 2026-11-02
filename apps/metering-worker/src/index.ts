import type { Env } from "./env.js";
import { route } from "./router.js";
import { runScheduledMaterialization } from "./rollups.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduledMaterialization(env);
  },
} satisfies ExportedHandler<Env>;

// perf(db): the per-request DB client is deliberate, not an oversight.
// Cross-request socket reuse is forbidden on Workers — a module-scoped pool
// fails with "Cannot perform I/O on behalf of a different request", and when
// it was tried it broke membership (500) and billing (flaky 503) on stage.
// It is also unnecessary: Hyperdrive pools the upstream connection, so this
// client talks to a local socket. Do not retry without a stage canary.
// See specs/epics/saas-performance/risks-and-open-questions.md.
