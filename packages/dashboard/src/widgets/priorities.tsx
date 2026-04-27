import { fetchWidgetServer } from "@/lib/api";

/**
 * Matches the shape served by `packages/server/src/api/widgets/priorities.ts`.
 * Kept duplicated here rather than imported from `@onenomad/cortex` because
 * the dashboard is deliberately a thin HTTP client (ADR-015); coupling to
 * the server's TypeScript would pull its entire workspace dep graph in.
 */
export interface PriorityRow {
  sourceId: string;
  content: string;
  project?: string | string[];
  owner?: string;
  due?: string;
  type?: string;
  source?: string;
  url?: string;
  date?: string;
  reason: "overdue" | "due-soon" | "just-nudged" | "fresh-decision";
}

export interface PrioritiesData {
  owner?: string;
  generatedAt: string;
  rows: PriorityRow[];
  note?: string;
}

const REASON_LABEL: Record<PriorityRow["reason"], string> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  "just-nudged": "Recently active",
  "fresh-decision": "New decision",
};

const REASON_CLASS: Record<PriorityRow["reason"], string> = {
  overdue: "bg-red-500/15 text-red-700 dark:text-red-300",
  "due-soon": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "just-nudged": "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "fresh-decision": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export async function PrioritiesWidget({
  owner,
  limit = 20,
  workspace,
}: {
  owner?: string;
  limit?: number;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: PrioritiesData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = { limit };
    if (owner) params.owner = owner;
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<PrioritiesData>("priorities", params);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Priorities</h2>
        {data && (
          <span className="text-xs text-neutral-500">
            {data.rows.length} item{data.rows.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data?.note && !data.rows.length && (
        <p className="text-sm text-neutral-500">{data.note}</p>
      )}

      {data && data.rows.length > 0 && (
        <ul className="space-y-2">
          {data.rows.map((row) => (
            <li
              key={`${row.sourceId}-${row.reason}`}
              className="flex gap-3 rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800"
            >
              <span
                className={`mt-0.5 inline-block self-start rounded px-2 py-0.5 text-xs font-medium ${REASON_CLASS[row.reason]}`}
              >
                {REASON_LABEL[row.reason]}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{row.content}</p>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-neutral-500">
                  {row.project && (
                    <span>
                      {Array.isArray(row.project)
                        ? row.project.join(", ")
                        : row.project}
                    </span>
                  )}
                  {row.due && <span>due {row.due}</span>}
                  {row.owner && <span>@{row.owner}</span>}
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
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
