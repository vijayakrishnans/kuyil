"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateOrgFlow } from "@/components/orgs/create-org-flow";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { useSession } from "@/lib/session";
import { useRequireAuth } from "@/lib/use-async";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { defaultOrgDestination, readLastOrgSlug } from "@/lib/last-org";
import { consoleTitle } from "@/lib/app-config";

/**
 * Mandatory first-run onboarding (Supabase/Vercel-style): a focused, full-screen
 * surface — no app shell — where a freshly signed-up user names their parent
 * organization and picks a billing plan before anything else. The console has
 * no org-less working view, so this page is the only destination for an
 * authenticated user with zero organizations (the app shell's `OnboardingGate`
 * funnels here); once an org exists this page forwards to it instead.
 */
export default function OnboardingPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const { client, setToken } = useSession();
  const orgs = useApiQuery(
    qk.orgs(),
    () => wrap(async () => (await client.organizations.list()).organizations),
    { enabled: ready },
  );

  // Already onboarded — forward to the remembered org if it's still accessible,
  // else the account's billing-parent org. Covers deep links to /onboarding and
  // the post-create transition before the router leaves this page.
  const onboarded = (orgs.data?.length ?? 0) > 0;
  React.useEffect(() => {
    if (!orgs.data || orgs.data.length === 0) return;
    const last = readLastOrgSlug();
    const slug = orgs.data.some((o) => o.slug === last)
      ? last
      : pickAccountBillingOrg(orgs.data)!.slug;
    router.replace(defaultOrgDestination(slug));
  }, [orgs.data, router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 md:px-8">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/40 text-sm font-bold text-primary-foreground">
            S
          </div>
          <span className="text-sm font-semibold tracking-tight">{consoleTitle()}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setToken(null);
            router.replace("/login");
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 md:px-8">
        {!ready || orgs.loading || onboarded ? (
          <OnboardingSkeleton />
        ) : orgs.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">Failed to load your account</CardTitle>
              <CardDescription>{orgs.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <CreateOrgFlow mode="parent" billingParent={null} variant="onboarding" />
        )}
      </main>
    </div>
  );
}

function OnboardingSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex gap-10 pt-2">
        <div className="hidden w-56 shrink-0 space-y-8 md:block">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 flex-1 rounded-lg" />
      </div>
    </div>
  );
}
