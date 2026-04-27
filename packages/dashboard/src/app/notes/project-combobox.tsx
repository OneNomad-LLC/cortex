"use client";

import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import {
  invokeNoteTool,
  type ListProjectsResponse,
  type ProjectRow,
} from "./lib/mcp";

interface ProjectComboboxProps {
  value: string;
  onChange: (slug: string) => void;
  placeholder?: string;
}

/**
 * Combobox that pulls the project list from cortex on mount and
 * filters as the user types. The input remains free-text so the user
 * can still enter a slug that doesn't exist yet (which is later
 * caught by validation on save). Slugs from `config/projects.yaml`
 * appear in a Popover panel below the field; pressing Enter or
 * clicking commits the highlighted match.
 */
export function ProjectCombobox({
  value,
  onChange,
  placeholder,
}: ProjectComboboxProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectRow[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await invokeNoteTool<ListProjectsResponse>(
          "list_projects",
          { activeOnly: false },
        );
        if (!cancelled) setProjects(result.projects);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setProjects([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = value.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.slug.localeCompare(b.slug);
    });
    if (!q) return sorted.slice(0, 30);
    return sorted
      .filter((p) => {
        const haystack = [p.slug, p.name, ...p.aliases]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 30);
  }, [projects, value]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered, highlight]);

  function commit(slug: string): void {
    onChange(slug);
    setOpen(false);
    inputRef.current?.blur();
  }

  return (
    <Popover open={open && filtered.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setOpen(true);
                setHighlight((h) => Math.min(h + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" && open && filtered[highlight]) {
                e.preventDefault();
                commit(filtered[highlight].slug);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={placeholder ?? "project-slug"}
            className="pr-8"
          />
          <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[--radix-popover-trigger-width] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {loadError ? (
          <div className="px-3 py-2 text-xs text-destructive">
            {loadError}
          </div>
        ) : !projects ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No matches. Type a new slug to use it anyway.
          </div>
        ) : (
          <ScrollArea className="max-h-64">
            <ul className="py-1">
              {filtered.map((p, idx) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => commit(p.slug)}
                    onMouseEnter={() => setHighlight(idx)}
                    className={cn(
                      "flex w-full items-start gap-2 px-2 py-1.5 text-left text-sm",
                      idx === highlight && "bg-accent text-accent-foreground",
                      !p.active && "opacity-60",
                    )}
                  >
                    <Check
                      className={cn(
                        "mt-0.5 h-3.5 w-3.5 shrink-0",
                        p.slug === value
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs">{p.slug}</span>
                        {!p.active && (
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            archived
                          </span>
                        )}
                      </div>
                      {p.name && p.name !== p.slug && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.name}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
