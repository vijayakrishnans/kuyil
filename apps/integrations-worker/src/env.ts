export interface Env {
  PLATFORM_DB?: Hyperdrive;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /**
   * Free-tier profile switch ("true" to enable). Shrinks the inbox drain's
   * per-pass batch so a tick fits the Workers Free plan's 10ms CPU /
   * 50-subrequest invocation ceiling. See specs/profiles/free-tier.md.
   */
  FREE_TIER?: string;

  // ── Per-environment secrets (wrangler secret put; never vars) ──
  // All optional until the GitHub App is registered for the environment
  // (saas-integrations risks-and-open-questions.md D1). The worker stays
  // dormant — health-only — while they are unset.

  /** Hex-encoded 256-bit key for installation-token-cache encryption (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY?: string;
  /** HMAC key for the signed single-use connect-flow state. */
  INTEGRATIONS_STATE_SECRET?: string;
  /** GitHub App identity (per environment). */
  GITHUB_APP_ID?: string;
  /** PEM-encoded RS256 private key for App JWT minting. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** HMAC secret GitHub signs inbound webhook deliveries with. */
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** GitHub App slug, used to build the public install URL. */
  GITHUB_APP_SLUG?: string;
}
