// M0 / Solo profile — the single instance-wide switch (SOLO_MODE).
//
// When SOLO_MODE is on, the product behaves as a single-user B2C app: the user
// IS the tenant (one auto-provisioned, invisible personal organization) and
// never sees orgs, teams, projects, or platform plumbing. This module is the
// api-edge ENFORCEMENT seam — the one place that decides, for a single request,
// whether a route is suppressed under the Solo profile. `index.ts` consults it
// once, before dispatching to any facade, and 404s a suppressed route.
//
// Design contract (specs/profiles/solo-m0.md):
//   - Suppress, don't remove. No facade is deleted; matchers are reused.
//   - Everything keys off this one flag. Flip SOLO_MODE off (unset the wrangler
//     var) and `isSoloMode` returns false, this predicate is never consulted,
//     and the full multi-tenant baseline is restored unchanged.
//   - RBAC/billing/audit keep running on their existing paths underneath.

import type { Env } from "./env";
import { isProjectRoute } from "./project-facade";
import { isMeteringRoute } from "./metering-facade";
import { isWebhooksRoute } from "./webhooks-facade";
import { isIntegrationsRoute, isIntegrationsIngressRoute } from "./integrations-facade";

/**
 * Is this instance running the M0/Solo profile? Deploy-time wrangler var; an
 * absent or non-"true" value means the full multi-tenant baseline (the safe
 * default — Solo is strictly opt-in).
 */
export function isSoloMode(env: Env): boolean {
  return env.SOLO_MODE === "true";
}

// Org sub-resources hidden under Solo. The personal org itself stays usable
// (GET list + GET by id); only the collaboration and credential surfaces are
// suppressed. Patterns mirror org-facade's own matchers (members/invitations/
// api-keys, with or without a trailing id segment).
const ORG_MEMBERS_RE = /^\/v1\/organizations\/[^/]+\/members(?:\/[^/]+)?$/;
const ORG_INVITATIONS_RE = /^\/v1\/organizations\/[^/]+\/invitations(?:\/[^/]+)?$/;
const ORG_API_KEYS_RE = /^\/v1\/organizations\/[^/]+\/api-keys(?:\/[^/]+)?$/;
const ORG_COLLECTION = "/v1/organizations";

/**
 * Is this (path, method) suppressed under the Solo profile?
 *
 * Suppressed (404 at the edge when SOLO_MODE is on):
 *   - projects & environments        — entire bounded context
 *   - metering / quotas              — entire bounded context
 *   - outbound webhooks              — entire bounded context
 *   - integrations + install ingress — entire bounded context
 *   - org members & invitations      — collaboration surface
 *   - org-scoped API keys            — credentials (M0-hidden; flag re-enables)
 *   - creating a *second* org        — POST /v1/organizations
 *
 * Kept (NOT suppressed — the single-user surfaces):
 *   - auth (magic-link + OAuth), account/profile
 *   - per-user billing (checkout/portal) and the provider billing webhook
 *   - config: settings & feature flags
 *   - notifications, silent audit logging
 *   - reading and using the one personal org (GET /v1/organizations[/:id])
 *
 * `isSoloMode` is checked separately by the caller, so this is a pure routing
 * predicate (no env) and trivially unit-testable for both profile states.
 */
export function isSoloSuppressed(pathname: string, method: string): boolean {
  // Whole bounded contexts the B2C user never sees.
  if (isProjectRoute(pathname)) return true;
  if (isMeteringRoute(pathname)) return true;
  if (isWebhooksRoute(pathname)) return true;
  if (isIntegrationsRoute(pathname) || isIntegrationsIngressRoute(pathname)) return true;

  // Org collaboration + credential sub-resources.
  if (ORG_MEMBERS_RE.test(pathname)) return true;
  if (ORG_INVITATIONS_RE.test(pathname)) return true;
  if (ORG_API_KEYS_RE.test(pathname)) return true;

  // The user is the tenant: never let them create a second org. Listing and
  // reading the personal org stay open (GET), so the console can resolve it.
  if (pathname === ORG_COLLECTION && method.toUpperCase() === "POST") return true;

  return false;
}
