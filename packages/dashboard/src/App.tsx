import * as React from "react";
import { Redirect, Route, Router, Switch } from "wouter";

import { AppShell } from "@/components/shell/AppShell";
import { AuthErrorBoundary } from "@/components/auth/AuthErrorBoundary";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthProvider } from "@/lib/auth-context";
import { IdentityPage } from "@/pages/IdentityPage";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage, PlaceholderPage } from "@/pages/PlaceholderPage";
import { WorkspacesPage } from "@/pages/WorkspacesPage";

/**
 * Dashboard router. Wouter is configured with `base="/_dashboard"` so
 * route paths stay sane (`/login`, `/adapters`, etc.) while the URL
 * bar shows the full `/_dashboard/...` namespace.
 *
 * Surface map:
 *   /login                  → LoginPage (no auth, no shell chrome)
 *   /                       → redirect to /adapters
 *   /adapters{,/...}        → wizard teammate's pages (placeholders for now)
 *   /logs, /jobs, /stats,   → ops teammate's pages (placeholders)
 *   /ingest, /memories      ↳
 *   /workspaces             → WorkspacesPage (shell)
 *   /identity               → IdentityPage (shell)
 *   *                       → 404
 *
 * <AuthProvider> wraps the whole tree so login + protected routes
 * both have access. <AuthErrorBoundary> listens for 401 events and
 * redirects to /login regardless of which page threw.
 */
export default function App(): React.ReactElement {
  return (
    <Router base="/_dashboard">
      <AuthProvider>
        <AuthErrorBoundary>
          <Switch>
            <Route path="/login">
              <LoginPage />
            </Route>

            <Route>
              <ProtectedRoute>
                <AppShell>
                  <Switch>
                    <Route path="/">
                      <Redirect to="/adapters" />
                    </Route>

                    {/* Wizard teammate slice — placeholders only. */}
                    <Route path="/adapters">
                      <PlaceholderPage
                        title="Adapters"
                        owner="wizard"
                        description="Adapters list, configuration, and run logs."
                      />
                    </Route>
                    <Route path="/adapters/new">
                      <PlaceholderPage
                        title="New adapter"
                        owner="wizard"
                        description="Adapter onboarding wizard."
                      />
                    </Route>
                    <Route path="/adapters/:id">
                      <PlaceholderPage
                        title="Adapter detail"
                        owner="wizard"
                        description="Per-adapter config + run history."
                      />
                    </Route>

                    {/* Ops teammate slice — placeholders only. */}
                    <Route path="/logs">
                      <PlaceholderPage title="Logs" owner="ops" />
                    </Route>
                    <Route path="/jobs">
                      <PlaceholderPage title="Jobs" owner="ops" />
                    </Route>
                    <Route path="/stats">
                      <PlaceholderPage title="Stats" owner="ops" />
                    </Route>
                    <Route path="/ingest">
                      <PlaceholderPage title="Ingest" owner="ops" />
                    </Route>
                    <Route path="/memories">
                      <PlaceholderPage title="Memories" owner="ops" />
                    </Route>

                    {/* Shell slice — fully implemented here. */}
                    <Route path="/workspaces">
                      <WorkspacesPage />
                    </Route>
                    <Route path="/identity">
                      <IdentityPage />
                    </Route>

                    <Route>
                      <NotFoundPage />
                    </Route>
                  </Switch>
                </AppShell>
              </ProtectedRoute>
            </Route>
          </Switch>
        </AuthErrorBoundary>
      </AuthProvider>
    </Router>
  );
}
