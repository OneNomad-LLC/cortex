import * as React from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Boxes,
  Brain,
  Database,
  IdCard,
  ListChecks,
  Menu,
  Plug,
  Settings2,
  UserCog,
  Workflow,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import {
  ProfileMenu,
  WorkspaceSwitcher,
} from "@/components/shell/WorkspaceSwitcher";

/**
 * Dashboard application shell.
 *
 *   - Top bar (logo, workspace switcher, profile menu)
 *   - Left sidebar with primary nav (collapses to a hamburger sheet on
 *     mobile breakpoints)
 *   - Main content area, scrollable, padded
 *
 * The sidebar is rendered for every authed page; the LoginPage opts
 * out and renders bare. Active route highlighting uses wouter's
 * `useLocation` so cross-page navigation stays a single-source
 * sidebar.
 */

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

// Sidebar order mirrors the dashboard's logical grouping: data first
// (adapters → ingest → memories), then ops + identity, then admin
// (workspaces, identity). Logs/Jobs/Stats live near the bottom because
// they're more diagnostic than primary action surfaces.
// wouter's <Router base="/_dashboard"> auto-prepends the base segment
// on every <Link href>. So these stay BASE-RELATIVE (no /_dashboard
// prefix) — wouter renders them as /_dashboard/adapters etc. and
// internal navigation routes by the unprefixed path.
// "Connectors" is the user-facing source directory (browse + connect).
// "Adapters" remains the ops view (configured rows + status + run
// controls) — they serve different jobs so we keep both for now.
const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { label: "Connectors", href: "/connectors", icon: Plug },
  { label: "Adapters", href: "/adapters", icon: Settings2 },
  { label: "Ingest", href: "/ingest", icon: Workflow },
  { label: "Memories", href: "/memories", icon: Brain },
  { label: "Logs", href: "/logs", icon: ListChecks },
  { label: "Jobs", href: "/jobs", icon: Boxes },
  { label: "Stats", href: "/stats", icon: Activity },
  { label: "Workspaces", href: "/workspaces", icon: Database },
  { label: "Identity", href: "/identity", icon: IdCard },
  { label: "Access", href: "/settings/access", icon: UserCog },
];

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps): React.ReactElement {
  const { logout } = useAuth();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-background px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Toggle navigation"
            className="inline-flex size-9 items-center justify-center rounded-md border border-input bg-background hover:bg-accent md:hidden"
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
          </button>
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <span className="rounded-md bg-primary px-1.5 py-0.5 text-xs font-bold uppercase text-primary-foreground">
              przm
            </span>
            <span>cortex</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <WorkspaceSwitcher />
          <ProfileMenu onLogout={() => void logout()} />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          isMobileOpen={mobileOpen}
          onMobileNavigate={() => setMobileOpen(false)}
        />

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

interface SidebarProps {
  isMobileOpen: boolean;
  onMobileNavigate: () => void;
}

function Sidebar({ isMobileOpen, onMobileNavigate }: SidebarProps): React.ReactElement {
  const [location] = useLocation();

  return (
    <>
      {/* Desktop: fixed-width sidebar */}
      <nav className="hidden w-56 shrink-0 border-r border-border bg-background md:block">
        <SidebarList location={location} />
      </nav>

      {/* Mobile: slide-down sheet anchored under the header. Plain
          CSS, no animation library — opening/closing toggles a class. */}
      {isMobileOpen && (
        <nav
          className="absolute left-0 right-0 top-14 z-20 border-b border-border bg-background shadow-sm md:hidden"
          onClick={onMobileNavigate}
        >
          <SidebarList location={location} />
        </nav>
      )}
    </>
  );
}

function SidebarList({ location }: { location: string }): React.ReactElement {
  return (
    <ul className="space-y-0.5 p-2">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = isActiveRoute(location, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Active when the current path equals the nav href or sits underneath
 * it. Special-cased to avoid an exact-match on "/_dashboard/" matching
 * everything ('cause every dashboard URL starts with that prefix).
 */
function isActiveRoute(current: string, href: string): boolean {
  if (current === href) return true;
  if (href.endsWith("/")) return current.startsWith(href);
  return current === href || current.startsWith(`${href}/`);
}
