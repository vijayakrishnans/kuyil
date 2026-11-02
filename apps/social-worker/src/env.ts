// perf(db): per-request DB client, same as every Lumen worker — Hyperdrive
// pools the upstream connection; cross-request socket reuse is forbidden.
export interface Env {
  PLATFORM_DB?: Hyperdrive;
  ENVIRONMENT: string;
  /**
   * "true" makes a reply to a stranger hold a refundable deposit. Off wherever
   * real money cannot enter (prod today): a required deposit with no way to
   * fund it would stop every new user replying to anyone who doesn't follow them.
   */
  REPLY_DEPOSITS_ENABLED?: string;
  /** Comma-separated usr_ public ids allowed to work the legal report queue. */
  SOCIAL_ADMINS?: string;
}
