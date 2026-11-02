export interface Env {
  PLATFORM_DB?: Hyperdrive;
  POLICY_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  ENVIRONMENT: string;
  DEBUG_DELIVERY?: string;
}
