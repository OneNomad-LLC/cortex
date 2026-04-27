import { fetchWidgetServer } from "@/lib/api";

export interface WhoKnowsRow {
  slug: string;
  name: string;
  role?: string;
  email?: string;
  mentions: number;
  lastTouchedIso: string;
  types: Array<{ type: string; count: number }>;
  lastPreview?: string;
}

export interface WhoKnowsData {
  topic: string;
  projectSlug?: string;
  since: string;
  rows: WhoKnowsRow[];
  note?: string;
}

export async function WhoKnowsWidget({
  topic,
  days = 90,
  limit = 8,
  workspace,
}: {
  topic?: string;
  days?: number;
  limit?: number;
  workspace?: string;
}): Promise<React.JSX.Element> {
  let data: WhoKnowsData | undefined;
  let error: string | undefined;
  try {
    const params: Record<string, string | number> = { days, limit };
    if (topic) params.topic = topic;
    if (workspace) params.workspace = workspace;
    data = await fetchWidgetServer<WhoKnowsData>("who-knows", params);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {topic ? `Who knows: ${topic}` : "Who knows"}
        </h2>
        {data && data.rows.length > 0 && (
          <span className="text-xs text-neutral-500">
            last {days}d · top {data.rows.length}
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
              key={row.slug}
              className="rounded-md border border-neutral-100 px-3 py-2 dark:border-neutral-800"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {row.name}
                  {row.role && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      {row.role}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {row.mentions} mention{row.mentions === 1 ? "" : "s"}
                </span>
              </div>
              {row.types.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.types.slice(0, 4).map((t) => (
                    <span
                      key={t.type}
                      className="rounded bg-neutral-500/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-700 dark:text-neutral-300"
                    >
                      {t.type} × {t.count}
                    </span>
                  ))}
                </div>
              )}
              {row.lastPreview && (
                <p className="mt-1 truncate text-xs text-neutral-500">
                  {row.lastPreview}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
