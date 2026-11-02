import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";
import { sweepExpiredDeposits } from "./handlers.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  // Every 15 minutes: refund reply deposits nobody acted on within 24h.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PLATFORM_DB) return;
    const ex = createSqlExecutor(env.PLATFORM_DB);
    ctx.waitUntil(
      sweepExpiredDeposits(ex)
        .then((n) => {
          // eslint-disable-next-line no-console -- cron outcome for Workers Logs
          console.log(JSON.stringify({ level: "info", msg: "social.deposits.swept", refunded: n }));
        })
        .finally(() => ex.dispose()),
    );
  },
} satisfies ExportedHandler<Env>;
