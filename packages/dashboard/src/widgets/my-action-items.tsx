import { fetchWidgetServer } from "@/lib/api";

/**
 * Mirrors `packages/server/src/api/widgets/my-action-items.ts`. Kept
 * duplicated rather than imported — see ADR-015.
 */
export interface ActionItemRow {
  sourceId: string;
  content: string;
  owner?: string;
  due?: string;
  status: "open" | "done" | "dropped" | "in_progress";
  project?: string | string[];
  source?: string;
  url?: string;
  date?: string;
}

export interface MyActionItemsData {
  owner?: string;
  projectSlug?: string;
  since: string;
  open: ActionItemRow[];
  done?: ActionItemRow[];
  note?: string;
}

const STATUS_CLASS: Record<ActionItemRow["status"], string> = {
  open: "bg-neutral-500/15 text-neutral-700 dark:text-neutral-300",
  in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  dropped: "bg-neutral-500/10 text-neutral-500",
};

const STATUS_LABEL: Record<ActionItemRow["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  dropped: "Dropped",
};

export async function MyActionItemsWidget({
  owner,
  project,
  days = 30,
  limit = 25,
  includeDone = false,
  workspace,
}: {
  owner?: string;
  project?: string;
  days?: number;
  limit?: number;
  includeDone?: boolean;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: MyActionItemsData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = { days, limit };
    if (owner) params.owner = owner;
    if (project) params.project = project;
    if (includeDone) params.includeDone = "true";
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<MyActionItemsData>(
      "my-action-items",
      params,
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const openCount = data?.open.length ?? 0;
  const doneCount = data?.done?.length ?? 0;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {owner ? `${owner}'s action items` : "Action items"}
        </h2>
        {data && (
          <span className="text-xs text-neutral-500">
            {openCount} open
            {includeDone && doneCount > 0 ? ` · ${doneCount} done` : ""}
          </span>
        )}
      </header>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t reach the Cortex API: {error}
        </p>
      )}

      {data?.note && openCount === 0 && (
        <p className="text-sm text-neutral-500">{data.note}</p>
      )}

      {data && openCount > 0 && (
        <ul className="space-y-2">
          {data.open.map((row) => (
            <ActionRow key={row.sourceId} row={row} />
          ))}
        </ul>
      )}

      {includeDone && data?.done && doneCount > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
            Done
          </h3>
          <ul className="space-y-2 opacity-70">
            {data.done.map((row) => (
              <ActionRow key={row.sourceId} row={row} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ActionRow({ row }: { row: ActionItemRow }): React.JSX.Element {
  return (
    <li className="flex gap-3 rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800">
      <span
        className={`mt-0.5 inline-block self-start rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}
      >
        {STATUS_LABEL[row.status]}
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
  );
}
