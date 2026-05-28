import * as React from "react";
import { Redirect, Route, Router, Switch } from "wouter";

import { AppShell } from "@/components/shell/AppShell";
import { AuthErrorBoundary } from "@/components/auth/AuthErrorBoundary";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { AuthProvider } from "@/lib/auth-context";
import { ToastProvider } from "@/components/ui/toast";
import { AccessPage } from "@/pages/AccessPage";
import { AdapterAddPage } from "@/pages/AdapterAddPage";
import { AdapterDetailPage } from "@/pages/AdapterDetailPage";
import { AdaptersListPage } from "@/pages/AdaptersListPage";
import { AuditPage } from "@/pages/AuditPage";
import { GitHubReposPage } from "@/pages/GitHubReposPage";
import { IdentityPage } from "@/pages/IdentityPage";
import IngestPage from "@/pages/IngestPage";
import { InvitationsPage } from "@/pages/InvitationsPage";
import JobsPage from "@/pages/JobsPage";
import LogsPage from "@/pages/LogsPage";
import { LoginPage } from "@/pages/LoginPage";
import { MembersPage } from "@/pages/MembersPage";
import { MemoriesPage } from "@/pages/MemoriesPage";
import { NotFoundPage } from "@/pages/PlaceholderPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { QueriesPage } from "@/pages/QueriesPage";
import StatsPage from "@/pages/StatsPage";
import { WorkspacesPage } from "@/pages/WorkspacesPage";

/**
 * Dashboard router. Wouter is configured with `base="/_dashboard"` so
 * route paths stay sane (`/login`, `/adapters`, etc.) while the URL
 * bar shows the full `/_dashboard/...` namespace.
 *
 * Surface map:
 *   /login                  → LoginPage (no auth, no shell chrome)
 *   /                       → redirect to /stats
 *   /connectors             → redirect to /adapters (merged)
 *   /adapters{,/new,/:id}   → adapter management (cards + wizard + ops table)
 *   /integrations/github    → GitHubReposPage
 *   /logs                   → runtime log tail
 *   /jobs                   → background ingest jobs
 *   /stats                  → KB size + per-source counts
 *   /ingest                 → URL / file / raw-content ingest forms
 *   /memories               → memory browser (paginated KB explorer)
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
                        <Redirect to="/stats" />
                      </Route>

                      {/* /connectors was merged into /adapters. Keep a
                          redirect so any bookmarked or linked URLs land
                          in the right place. */}
                      <Route path="/connectors">
                        <Redirect to="/adapters" />
                      </Route>

                      {/* Adapter management (connector cards + ops table). */}
                      <Route path="/adapters" component={AdaptersListPage} />
                      <Route path="/adapters/new" component={AdapterAddPage} />
                      <Route path="/adapters/:id" component={AdapterDetailPage} />

                      {/* Per-source integration surfaces. */}
                      <Route
                        path="/integrations/github"
                        component={GitHubReposPage}
                      />

                      {/* Ops. */}
                      <Route path="/logs" component={LogsPage} />
                      <Route path="/jobs" component={JobsPage} />
                      <Route path="/stats" component={StatsPage} />
                      <Route path="/ingest" component={IngestPage} />
                      <Route path="/memories" component={MemoriesPage} />

                      {/* Shell. */}
                      <Route path="/workspaces">
                        <WorkspacesPage />
                      </Route>
                      <Route path="/identity">
                        <IdentityPage />
                      </Route>
                      <Route path="/settings/access" component={AccessPage} />

                      {/* Org admin surfaces. */}
                      <Route path="/members" component={MembersPage} />
                      <Route path="/projects" component={ProjectsPage} />
                      <Route path="/invitations" component={InvitationsPage} />
                      <Route path="/queries" component={QueriesPage} />
                      <Route path="/audit" component={AuditPage} />

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
