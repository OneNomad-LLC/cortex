"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  Cable,
  Cpu,
  FileText,
  LayoutDashboard,
  Package,
  Search,
  Settings,
  Terminal,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/search", label: "Search", icon: Search },
      { href: "/docs", label: "Docs", icon: BookOpen },
      { href: "/status", label: "Status", icon: Activity },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/adapters", label: "Adapters", icon: Cable },
      { href: "/providers", label: "Providers", icon: Cpu },
      { href: "/modules", label: "Modules", icon: Package },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
  {
    label: "Develop",
    items: [
      { href: "/mcp", label: "MCP Console", icon: Terminal },
      { href: "/logs", label: "Logs", icon: FileText },
      { href: "/setup", label: "Setup wizard", icon: Wrench },
    ],
  },
];

export function AppShell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-x-hidden">
        {/* pb-16 reserves space for the SyncDock collapsed bar at the
            bottom so the last widget doesn't sit under it. */}
        <div className="mx-auto max-w-6xl px-6 py-6 pb-16">{children}</div>
      </main>
    </div>
  );
}

function Sidebar(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-surface/40 text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b border-border-subtle px-5 font-mono text-sm font-semibold text-text-primary">
        {/* eslint-disable-next-line @next/next/no-img-element --
            using a bare <img> instead of next/image keeps the sidebar
            header server-render-stable without the Image component's
            loader noise for a tiny static asset. */}
        <img
          src="/cortex-logo.png"
          alt="Cortex"
          width={22}
          height={22}
          className="drop-shadow-[0_0_8px_rgba(244,114,182,0.35)]"
        />
        <span className="lowercase tracking-tight">cortex</span>
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="px-2 pb-2 font-mono text-[10px] font-medium uppercase tracking-widest text-text-disabled">
              {group.label}
            </p>
            <nav className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 font-mono text-sm transition-colors",
                      active
                        ? "bg-gold/10 text-gold"
                        : "text-text-secondary hover:bg-bg-raised/40 hover:text-text-primary",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{item.label}</span>
                    {item.badge && (
                      <Badge variant="secondary" className="ml-auto">
                        {item.badge}
                      </Badge>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>
        ))}
      </ScrollArea>

      <Separator className="bg-border-subtle" />
      <WorkspaceFooter />
    </aside>
  );
}

function WorkspaceFooter(): React.JSX.Element {
  const [workspace, setWorkspace] = React.useState<string | null | undefined>();

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/cortex/layout", { cache: "no-store" });
        if (!r.ok) throw new Error(`${r.status}`);
        const body = (await r.json()) as { workspace?: string | null };
        if (!cancelled) setWorkspace(body.workspace ?? null);
      } catch {
        if (!cancelled) setWorkspace(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="px-5 py-4 text-xs">
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-disabled">
        Workspace
      </p>
      <p className="mt-1 truncate font-mono text-sm text-text-primary">
        {workspace === undefined ? "…" : (workspace ?? "(none)")}
      </p>
    </div>
  );
}
