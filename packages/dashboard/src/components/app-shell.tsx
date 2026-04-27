"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BookOpen,
  BookText,
  Cable,
  Cpu,
  FileText,
  LayoutDashboard,
  LayoutGrid,
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
import { ThemeToggle } from "@/components/theme-toggle";

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
      { href: "/", label: "Today", icon: LayoutDashboard },
      { href: "/notes", label: "Notes", icon: BookText },
      { href: "/widgets", label: "Widgets", icon: LayoutGrid },
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
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-mono text-xs font-bold">
          Cx
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">Cortex</span>
          <span className="text-[10px] text-muted-foreground">
            work-knowledge
          </span>
        </div>
      </div>

      <ScrollArea className="flex-1 px-2 py-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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

      <Separator />
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
    <div className="flex items-center gap-2 p-3 text-xs">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">workspace</p>
        <p className="truncate font-mono font-medium">
          {workspace === undefined ? "…" : (workspace ?? "(none)")}
        </p>
      </div>
      <ThemeToggle />
    </div>
  );
}
