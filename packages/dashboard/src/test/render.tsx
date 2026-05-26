import * as React from "react";
import { render } from "@testing-library/react";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@/components/ui/toast";

/**
 * Test render helper. Wraps the unit-under-test in every provider the
 * real app composes at boot:
 *
 *   <Router base="/_dashboard">
 *     <ToastProvider>
 *       <QueryClientProvider>
 *         <AuthProvider>
 *           {ui}
 *
 * The `wouter/memory-location` hook gives us a non-history-backed
 * location so tests can assert on navigation (`location.history`) and
 * drive the router without a real browser URL bar. Each render gets a
 * fresh `QueryClient` so cached data from a previous test never leaks
 * into the next.
 *
 * Options:
 *   - `route`: initial URL the memory location starts at (default "/")
 *
 * Returns the testing-library `RenderResult` PLUS the memory-location
 * tuple so a test can `expect(history.at(-1)).toBe("/somewhere")`.
 */
export interface AppRenderOptions extends RenderOptions {
  /** Initial URL the wouter Router boots at (under the /_dashboard base). */
  route?: string;
}

export interface AppRenderResult extends RenderResult {
  /** Navigate programmatically — exposed for tests that need it. */
  navigate: (path: string) => void;
  /** All paths the memory location has visited, oldest first. */
  history: string[];
  queryClient: QueryClient;
}

export function renderApp(
  ui: React.ReactElement,
  options: AppRenderOptions = {},
): AppRenderResult {
  const { route = "/", ...rest } = options;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const { hook, history, navigate } = memoryLocation({
    path: route,
    record: true,
  });

  const result = render(ui, {
    wrapper: ({ children }) => (
      <Router hook={hook} base="/_dashboard">
        <ToastProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>{children}</AuthProvider>
          </QueryClientProvider>
        </ToastProvider>
      </Router>
    ),
    ...rest,
  });

  return {
    ...result,
    navigate,
    history,
    queryClient,
  };
}
