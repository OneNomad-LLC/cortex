"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
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
  RotateCcw,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface CommandItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  group: "Navigate" | "Action" | "Workspace";
  keywords?: string[];
  action?: () => void | Promise<void>;
}

/**
 * Global cmd-k command palette. Mounted once at the app shell level
 * via CommandPaletteProvider so every page can open it.
 *
 * Triggers:
 *   - Cmd/Ctrl + K
 *   - Cmd/Ctrl + Shift + P (matches VS Code muscle memory)
 */
export function CommandPalette(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [workspaces, setWorkspaces] = React.useState<
    { slug: string; active: boolean }[]
  >([]);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const cmdShiftP =
        (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p";
      if (cmdK || cmdShiftP) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Fetch workspaces lazily — when the palette opens, not on every render.
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/cortex/workspaces", { cache: "no-store" });
        if (!r.ok) return;
        const body = (await r.json()) as {
          workspaces: { slug: string; active: boolean }[];
        };
        if (!cancelled) setWorkspaces(body.workspaces);
      } catch {
        // best-effort — palette still works without the workspace list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const navItems: CommandItem[] = [
    { id: "today", label: "Today", icon: LayoutDashboard, href: "/", group: "Navigate", keywords: ["home", "timeline"] },
    { id: "notes", label: "Notes", icon: BookText, href: "/notes", group: "Navigate", keywords: ["markdown", "obsidian"] },
    { id: "widgets", label: "Widgets", icon: LayoutGrid, href: "/widgets", group: "Navigate" },
    { id: "search", label: "Search", icon: Search, href: "/search", group: "Navigate", keywords: ["find", "query"] },
    { id: "docs", label: "Docs", icon: BookOpen, href: "/docs", group: "Navigate", keywords: ["help", "guide", "readme"] },
    { id: "status", label: "Status", icon: Activity, href: "/status", group: "Navigate", keywords: ["heartbeat", "health"] },
    { id: "adapters", label: "Adapters", icon: Cable, href: "/adapters", group: "Navigate", keywords: ["integrations"] },
    { id: "providers", label: "Providers", icon: Cpu, href: "/providers", group: "Navigate", keywords: ["llm", "ollama", "openrouter"] },
    { id: "modules", label: "Modules", icon: Package, href: "/modules", group: "Navigate" },
    { id: "settings", label: "Settings", icon: Settings, href: "/settings", group: "Navigate", keywords: ["identity", "config"] },
    { id: "mcp", label: "MCP Console", icon: Terminal, href: "/mcp", group: "Navigate", keywords: ["tools", "invoke"] },
    { id: "logs", label: "Logs", icon: FileText, href: "/logs", group: "Navigate" },
    { id: "setup", label: "Setup wizard", icon: Wrench, href: "/setup", group: "Navigate" },
  ];

  const actionItems: CommandItem[] = [
    {
      id: "new-note",
      label: "New note…",
      icon: BookText,
      href: "/notes?new=1",
      group: "Action",
      keywords: ["create", "write", "markdown"],
    },
    {
      id: "reload",
      label: "Reload dashboard",
      icon: RotateCcw,
      group: "Action",
      keywords: ["refresh"],
      action: () => {
        window.location.reload();
      },
    },
  ];

  const workspaceItems: CommandItem[] = workspaces
    .filter((w) => !w.active)
    .map((w) => ({
      id: `workspace-${w.slug}`,
      label: `Switch to ${w.slug}`,
      icon: Settings,
      group: "Workspace",
      keywords: ["workspace", w.slug],
      action: async () => {
        try {
          const r = await fetch("/api/cortex/workspaces/switch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ slug: w.slug }),
          });
          if (!r.ok) throw new Error(`${r.status}`);
          // Workspace switch needs a daemon restart to take effect; do
          // a hard reload so the user sees the right dashboard state.
          window.location.reload();
        } catch (err) {
          console.error("workspace switch failed", err);
        }
      },
    }));

  function run(item: CommandItem): void {
    setOpen(false);
    if (item.href) {
      router.push(item.href);
      return;
    }
    if (item.action) {
      void item.action();
    }
  }

  if (!open) {
    return <CommandHint />;
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2 px-4">
        <Command
          loop
          className="overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            <Command.Input
              autoFocus
              placeholder="Type a command or search…"
              className="flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto p-1">
            <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
              No matches.
            </Command.Empty>

            <CommandGroup heading="Navigate">
              {navItems.map((item) => (
                <PaletteItem key={item.id} item={item} onSelect={() => run(item)} />
              ))}
            </CommandGroup>

            <CommandGroup heading="Actions">
              {actionItems.map((item) => (
                <PaletteItem key={item.id} item={item} onSelect={() => run(item)} />
              ))}
            </CommandGroup>

            {workspaceItems.length > 0 && (
              <CommandGroup heading="Workspaces">
                {workspaceItems.map((item) => (
                  <PaletteItem key={item.id} item={item} onSelect={() => run(item)} />
                ))}
              </CommandGroup>
            )}
          </Command.List>
          <div className="flex items-center justify-between border-t px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>↑↓ to navigate</span>
            <span>↵ to select</span>
            <span>esc to close</span>
          </div>
        </Command>
      </div>
    </>
  );
}

function CommandGroup({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Command.Group
      heading={heading}
      className="overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}

function PaletteItem({
  item,
  onSelect,
}: {
  item: CommandItem;
  onSelect: () => void;
}): React.JSX.Element {
  const Icon = item.icon;
  return (
    <Command.Item
      value={`${item.label} ${(item.keywords ?? []).join(" ")}`}
      onSelect={onSelect}
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{item.label}</span>
    </Command.Item>
  );
}

/**
 * Subtle visual hint at the corner of the screen so users discover the
 * palette without reading docs. Renders only when the palette is closed.
 */
function CommandHint(): React.JSX.Element {
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    // Hide forever once dismissed — local-storage flag.
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("cortex-cmdk-dismissed")) return;
    const t = window.setTimeout(() => setShow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return <></>;
  return (
    <button
      type="button"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-md border bg-popover px-3 py-2 text-xs shadow-md hover:bg-accent"
      onClick={() => {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("cortex-cmdk-dismissed", "1");
        }
        setShow(false);
      }}
    >
      <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
      <span className="text-muted-foreground">to navigate · click to dismiss</span>
    </button>
  );
}
