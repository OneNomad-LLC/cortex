import { LogsViewer } from "./logs-viewer";

export const dynamic = "force-dynamic";

/**
 * Live log stream from the Cortex sidecar. The viewer is a client
 * component subscribed to /api/cortex/logs/stream (SSE). Server
 * component is just the shell — auth bookkeeping for the SSE happens
 * via the same /api/cortex/* rewrite the rest of the dashboard uses,
 * so the browser cookie rides along.
 */
export default function LogsPage(): React.JSX.Element {
  return (
    <div className="space-y-6 p-8">
      <header>
        <h1 className="font-mono text-xl font-semibold text-text-primary">
          Logs
        </h1>
        <p className="mt-1 font-body text-sm text-text-secondary">
          Live tail of the Cortex sidecar. Newest events at the bottom.
        </p>
      </header>
      <LogsViewer />
    </div>
  );
}
