import { fetchLayoutServer } from "@/lib/api";
import {
  type ResolvedLayout,
  renderWidget,
} from "@/widgets/registry";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<React.JSX.Element> {
  let layout: ResolvedLayout | undefined;
  let error: string | undefined;
  try {
    layout = await fetchLayoutServer<ResolvedLayout>();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cortex</h1>
          <p className="text-sm text-neutral-500">
            Your work-knowledge dashboard. Local to this machine.
          </p>
        </div>
        {layout && (
          <span className="text-xs text-neutral-500">
            role: <span className="font-medium">{layout.role}</span>
          </span>
        )}
      </header>

      {error && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          Couldn&apos;t reach the Cortex API: {error}. Is{" "}
          <code>cortex start</code> running with{" "}
          <code>api.enabled: true</code>?
        </p>
      )}

      {layout && (
        <div className="grid gap-4 lg:grid-cols-2">
          {layout.widgets.map((w) => (
            <div key={w.name}>{renderWidget(w)}</div>
          ))}
        </div>
      )}
    </main>
  );
}
