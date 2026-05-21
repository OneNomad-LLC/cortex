import * as React from "react";
import { useLocation } from "wouter";
import {
  ApiUnauthorizedError,
  api,
  apiPost,
} from "@/lib/api";

/**
 * Dashboard auth state lives in a single React context so every page
 * (and every shell chrome component) can decide whether to render a
 * loading skeleton, the protected UI, or the login redirect.
 *
 * The provider does two non-obvious things:
 *
 * 1. On mount, it kicks off a single `/api/dashboard/auth/whoami` call
 *    to discover whether a session cookie is already valid. This is
 *    what keeps the dashboard "remembered" across page reloads.
 *
 * 2. It listens for the `cortex:unauthorized` window event dispatched
 *    by the `api()` helper on 401. Any throw — main query, mutation,
 *    background refetch — flips the provider to `anon` and the
 *    AuthErrorBoundary navigates to /login. This indirection saves
 *    every page from having to bubble auth errors manually.
 */

export interface WhoAmI {
  workspace: string | null;
  scopes: ReadonlyArray<"read" | "ingest" | "admin">;
  tokenLabel: string | null;
}

export type AuthStatus = "loading" | "authed" | "anon";

export interface AuthContextValue {
  status: AuthStatus;
  whoami: WhoAmI | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): React.ReactElement {
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [whoami, setWhoami] = React.useState<WhoAmI | null>(null);
  const [, setLocation] = useLocation();

  const refresh = React.useCallback(async () => {
    try {
      const result = await api<WhoAmI>("/api/dashboard/auth/whoami");
      setWhoami(result);
      setStatus("authed");
    } catch (err) {
      if (err instanceof ApiUnauthorizedError) {
        setWhoami(null);
        setStatus("anon");
        return;
      }
      // Other errors — surface as anon so the UI doesn't deadlock on
      // a spinner. The user can retry by hitting login again.
      setWhoami(null);
      setStatus("anon");
    }
  }, []);

  const logout = React.useCallback(async () => {
    try {
      await apiPost("/api/dashboard/auth/logout");
    } catch {
      // Logout is intentionally lenient on the server side; a
      // network error here still clears local state.
    }
    setWhoami(null);
    setStatus("anon");
    setLocation("/login");
  }, [setLocation]);

  // Initial probe — fires once on mount.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Listen for downstream 401s anywhere in the app.
  React.useEffect(() => {
    const handler = () => {
      setWhoami(null);
      setStatus("anon");
    };
    window.addEventListener("cortex:unauthorized", handler);
    return () => window.removeEventListener("cortex:unauthorized", handler);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ status, whoami, refresh, logout }),
    [status, whoami, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
