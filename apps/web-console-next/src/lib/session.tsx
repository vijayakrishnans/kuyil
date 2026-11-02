"use client";

import * as React from "react";
import type { Kuyil } from "@saas/sdk";
import {
  apiTargets,
  deployEnv,
  isLocked,
  createClient,
  type ApiTarget,
} from "./api";
import { appConfig } from "./app-config";

// Keys are built per call, not at import: the storage prefix is runtime config
// (saas-console-artifact CA1), installed by <Providers> before any of these run.
const tokenKey = (): string => `${appConfig().storagePrefix}.token`;
const targetKey = (): string => `${appConfig().storagePrefix}.target`;

/**
 * Read the persisted bearer token straight from localStorage (client only).
 * Shared by the provider's initial state and the auth guard so both observe the
 * exact same source of truth — the guard never bounces a user who actually has
 * a token, even before React state has propagated.
 */
export function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(tokenKey());
  } catch {
    return null;
  }
}

interface SessionCtx {
  client: Kuyil;
  target: ApiTarget;
  token: string | null;
  setToken: (t: string | null) => void;
  setTarget: (t: ApiTarget) => void;
  availableTargets: ApiTarget[];
  isLocked: boolean;
  deployEnv: string | undefined;
}

const Ctx = React.createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  // Read persisted session synchronously in the initializer (client only). This
  // means the token is already present on the *first* client render, so the auth
  // guard never observes a false `null` and bounces an authenticated user to
  // /login on a hard refresh or deep link. SSR returns null and the shell gates
  // on `ready` (set in an effect), so the committed markup stays consistent.
  const [target, setTargetState] = React.useState<ApiTarget>(() => {
    const targets = apiTargets();
    if (typeof window === "undefined") return targets[0]!;
    try {
      const saved = window.localStorage.getItem(targetKey());
      return targets.find((t) => t.name === saved) ?? targets[0]!;
    } catch {
      return targets[0]!;
    }
  });
  const [token, setTokenState] = React.useState<string | null>(() => readStoredToken());

  const client = React.useMemo(() => createClient(target, token), [target, token]);

  const setToken = React.useCallback((t: string | null) => {
    setTokenState(t);
    if (typeof window !== "undefined") {
      try {
        if (t) window.localStorage.setItem(tokenKey(), t);
        else window.localStorage.removeItem(tokenKey());
      } catch {
        /* ignore */
      }
    }
  }, []);

  const setTarget = React.useCallback((t: ApiTarget) => {
    setTargetState(t);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(targetKey(), t.name);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const value = React.useMemo<SessionCtx>(
    () => ({
      client,
      target,
      token,
      setToken,
      setTarget,
      availableTargets: apiTargets(),
      isLocked: isLocked(),
      deployEnv: deployEnv(),
    }),
    [client, target, token, setToken, setTarget],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useSession must be used inside <SessionProvider>");
  return c;
}
