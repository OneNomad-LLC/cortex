import * as React from "react";
import { Redirect, Route, Router, Switch } from "wouter";

import { AppShell } from "@/components/shell/AppShell";
import { AuthErrorBoundary } from "@/components/auth/AuthErrorBoundary";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthProvider } from "@/lib/auth-context";
import { AdapterAddPage } from "@/pages/AdapterAddPage";
import { AdapterDetailPage } from "@/pages/AdapterDetailPage";
import { AdaptersListPage } from "@/pages/AdaptersListPage";
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
 *   /adapters{,/new,/:id}   → adapter management (wizard)
 *   /logs, /jobs, /stats,   → ops pages (mounted in a follow-up merge)
 *   /ingest, /memories      ↳
 *   /workspaces             → WorkspacesPage
 *   /identity               → IdentityPage
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

                    {/* Adapter management (wizard). */}
                    <Route path="/adapters" component={AdaptersListPage} />
                    <Route path="/adapters/new" component={AdapterAddPage} />
                    <Route path="/adapters/:id" component={AdapterDetailPage} />

                    {/* Ops slice — pages mount in the ops merge. */}
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

                    {/* Shell slice. */}
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
