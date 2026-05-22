import * as React from "react";
import { Redirect, Route, Router, Switch } from "wouter";

import { AppShell } from "@/components/shell/AppShell";
import { AuthErrorBoundary } from "@/components/auth/AuthErrorBoundary";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@/components/ui/toast";
import { AdapterAddPage } from "@/pages/AdapterAddPage";
import { AdapterDetailPage } from "@/pages/AdapterDetailPage";
import { AdaptersListPage } from "@/pages/AdaptersListPage";
import { IdentityPage } from "@/pages/IdentityPage";
import IngestPage from "@/pages/IngestPage";
import JobsPage from "@/pages/JobsPage";
import LogsPage from "@/pages/LogsPage";
import { LoginPage } from "@/pages/LoginPage";
import { NotFoundPage, PlaceholderPage } from "@/pages/PlaceholderPage";
import StatsPage from "@/pages/StatsPage";
import { WorkspacesPage } from "@/pages/WorkspacesPage";

/**
 * Dashboard router. Wouter is configured with `base="/_dashboard"` so
 * route paths stay sane (`/login`, `/adapters`, etc.) while the URL
 * bar shows the full `/_dashboard/...` namespace.
 *
 * Surface map:
 *   /login                  → LoginPage (no auth, no shell chrome)
 *   /                       → redirect to /adapters
 *   /adapters{,/new,/:id}   → adapter management (wizard renderer)
 *   /logs                   → runtime log tail
 *   /jobs                   → background ingest jobs
 *   /stats                  → KB size + per-source counts
 *   /ingest                 → URL / file / raw-content ingest forms
 *   /memories               → memory browser (deferred)
 *   /workspaces             → WorkspacesPage
 *   /identity               → IdentityPage
 *   *                       → 404
 *
 * <AuthProvider> wraps the whole tree so login + protected routes
 * both have access. <AuthErrorBoundary> listens for 401 events and
 * redirects to /login regardless of which page threw.
 * <ToastProvider> wraps everything so any page can fire a toast
 * (ingest queue confirmations, mutation success, etc.).
 */
export default function App(): React.ReactElement {
  return (
    <Router base="/_dashboard">
      <ToastProvider>
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

                      {/* Adapter management. */}
                      <Route path="/adapters" component={AdaptersListPage} />
                      <Route path="/adapters/new" component={AdapterAddPage} />
                      <Route path="/adapters/:id" component={AdapterDetailPage} />

                      {/* Ops. */}
                      <Route path="/logs" component={LogsPage} />
                      <Route path="/jobs" component={JobsPage} />
                      <Route path="/stats" component={StatsPage} />
                      <Route path="/ingest" component={IngestPage} />
                      <Route path="/memories">
                        <PlaceholderPage title="Memories" owner="ops" />
                      </Route>

                      {/* Shell. */}
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
      </ToastProvider>
    </Router>
  );
}
