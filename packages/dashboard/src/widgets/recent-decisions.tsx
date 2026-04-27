import { fetchWidgetServer } from "@/lib/api";

/**
 * Mirrors `packages/server/src/api/widgets/recent-decisions.ts`. See ADR-015.
 */
export interface DecisionRow {
  sourceId: string;
  content: string;
  project?: string | string[];
  people?: string[];
  source?: string;
  url?: string;
  date?: string;
}

export interface RecentDecisionsData {
  projectSlug?: string;
  since: string;
  rows: DecisionRow[];
  note?: string;
}

export async function RecentDecisionsWidget({
  project,
  days = 7,
  limit = 15,
  workspace,
}: {
  project?: string;
  days?: number;
  limit?: number;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: RecentDecisionsData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = { days, limit };
    if (project) params.project = project;
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<RecentDecisionsData>(
      "recent-decisions",
      params,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Recent decisions</h2>
        {data && (
          <span className="text-xs text-neutral-500">
            last {days}d · {data.rows.length}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data?.note && data.rows.length === 0 && (
        <p className="text-sm text-neutral-500">{data.note}</p>
      )}

      {data && data.rows.length > 0 && (
        <ul className="space-y-2">
          {data.rows.map((row) => (
            <li
              key={row.sourceId}
              className="rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800"
            >
              <p className="text-sm">{row.content}</p>
              <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                {row.project && (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
                    {Array.isArray(row.project)
                      ? row.project.join(", ")
                      : row.project}
                  </span>
                )}
                {row.date && <span>{formatDate(row.date)}</span>}
                {row.people && row.people.length > 0 && (
                  <span>with {row.people.join(", ")}</span>
                )}
                {row.url && (
                  <a
                    className="underline underline-offset-2"
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    source
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
