import { fetchWidgetServer } from "@/lib/api";

/**
 * Mirrors `packages/server/src/api/widgets/recent-activity.ts`. See ADR-015
 * for the deliberate duplication.
 */
export interface RecentActivityProjectRow {
  project: string;
  count: number;
  lastTouchedIso: string;
  lastType?: string;
  lastContent?: string;
  lastSource?: string;
  lastUrl?: string;
}

export interface RecentActivityData {
  since: string;
  projects: RecentActivityProjectRow[];
  total: number;
  note?: string;
}

export async function RecentActivityWidget({
  days = 3,
  limit = 12,
  workspace,
}: {
  days?: number;
  limit?: number;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: RecentActivityData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = { days, limit };
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<RecentActivityData>(
      "recent-activity",
      params,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Recent activity</h2>
        {data && (
          <span className="text-xs text-neutral-500">
            last {days}d · {data.total} items
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data?.note && data.projects.length === 0 && (
        <p className="text-sm text-neutral-500">{data.note}</p>
      )}

      {data && data.projects.length > 0 && (
        <ul className="space-y-2">
          {data.projects.map((row) => (
            <li
              key={row.project}
              className="rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {row.project === "_unassigned" ? "Unassigned" : row.project}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {row.count} · {formatRelative(row.lastTouchedIso)}
                </span>
              </div>
              {row.lastContent && (
                <p className="mt-0.5 truncate text-xs text-neutral-600 dark:text-neutral-400">
                  {row.lastType ? `[${row.lastType}] ` : ""}
                  {row.lastContent}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60 * 60 * 1000) {
    const mins = Math.max(1, Math.round(diff / 60_000));
    return `${mins}m ago`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.round(diff / 3_600_000)}h ago`;
  }
  return `${Math.round(diff / 86_400_000)}d ago`;
}
