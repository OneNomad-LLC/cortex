"use client";

import * as React from "react";

interface LogLine {
  ts: string;
  level: string;
  msg: string;
  component?: string;
  [key: string]: unknown;
}

const LEVEL_TONE: Record<string, string> = {
  error: "text-destructive",
  warn: "text-orange",
  info: "text-text-primary",
  debug: "text-text-muted",
};

/**
 * Subscribes to /api/cortex/logs/stream (SSE). Each event is a JSON-
 * encoded log line; we keep the last 500 in memory so scrolling
 * doesn't lag in long sessions. EventSource carries the browser
 * cookie automatically since it's same-origin via the Next rewrite.
 */
export function LogsViewer(): React.JSX.Element {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [status, setStatus] = React.useState<"connecting" | "open" | "error">(
    "connecting",
  );

  React.useEffect(() => {
    const es = new EventSource("/api/cortex/logs/stream");
    es.onopen = () => setStatus("open");
    es.onerror = () => setStatus("error");
    es.onmessage = (event) => {
      try {
        const line = JSON.parse(event.data) as LogLine;
        setLines((prev) => {
          const next = prev.length >= 500 ? prev.slice(prev.length - 499) : prev.slice();
          next.push(line);
          return next;
        });
      } catch {
        // Drop malformed line silently.
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="rounded-lg border border-border-subtle bg-bg-base/60">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2 font-mono text-[10px] uppercase tracking-widest">
        <span
          className={
            status === "open"
              ? "text-mint"
              : status === "error"
                ? "text-destructive"
                : "text-text-muted"
          }
        >
          {status === "open" ? "● live" : status === "error" ? "● disconnected" : "○ connecting…"}
        </span>
        <span className="text-text-muted">{lines.length} line{lines.length === 1 ? "" : "s"}</span>
      </div>
      <div className="max-h-[70vh] overflow-y-auto p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-text-muted">Waiting for log events…</p>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="text-text-disabled">{formatTs(line.ts)}</span>{" "}
              <span className={LEVEL_TONE[line.level] ?? "text-text-primary"}>
                {(line.level ?? "info").padEnd(5)}
              </span>{" "}
              {line.component && (
                <span className="text-aqua">[{line.component}] </span>
              )}
              <span className="text-text-primary">{line.msg}</span>
              {formatExtras(line)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTs(raw: string): string {
  try {
    const d = new Date(raw);
    return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return raw;
  }
}

function formatExtras(line: LogLine): React.ReactNode {
  const ignored = new Set(["ts", "level", "msg", "component"]);
  const entries = Object.entries(line).filter(([k]) => !ignored.has(k));
  if (entries.length === 0) return null;
  return (
    <span className="text-text-muted">
      {entries.map(([k, v]) => ` ${k}=${formatValue(v)}`).join("")}
    </span>
  );
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}
