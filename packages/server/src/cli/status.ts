import { readHeartbeat, type Heartbeat } from "../heartbeat.js";

export async function runStatus(): Promise<number> {
  const hb = await readHeartbeat();
  if (!hb) {
    process.stdout.write(
      "cortex: no daemon running (heartbeat file not found).\n" +
        "Run `cortex start` in another terminal or via the Claude Code MCP config.\n",
    );
    return 1;
  }

  const fresh = isFresh(hb);
  const now = Date.now();

  process.stdout.write(`cortex daemon\n`);
  process.stdout.write(`=============\n`);
  process.stdout.write(`pid:         ${hb.pid}\n`);
  process.stdout.write(`started:     ${hb.startedAt}\n`);
  process.stdout.write(`uptime:      ${humanDuration(hb.uptimeMs)}\n`);
  process.stdout.write(
    `last beat:   ${hb.lastHeartbeatAt}${fresh ? "" : "  (STALE)"}\n`,
  );
  process.stdout.write(
    `mcp:         ${hb.mcp.connected ? "connected" : "disconnected"} (${hb.mcp.transport})\n`,
  );
  process.stdout.write(
    `upstream:    engram=${hb.upstream.engram ? "ok" : "down"}  persona=${hb.upstream.persona ? "ok" : "down"}\n`,
  );

  const adapterIds = Object.keys(hb.adapters).sort();
  if (adapterIds.length === 0) {
    process.stdout.write(`\nno adapters registered.\n`);
  } else {
    process.stdout.write(`\nadapters\n--------\n`);
    const rows: string[][] = [
      ["id", "schedule", "runs", "errs", "last run", "ingested", "state"],
    ];
    for (const id of adapterIds) {
      const a = hb.adapters[id]!;
      rows.push([
        id,
        a.schedule ?? "—",
        String(a.runs),
        String(a.errors),
        a.lastRunAt
          ? humanAgo(now - Date.parse(a.lastRunAt))
          : "never",
        a.lastRunIngested !== undefined ? String(a.lastRunIngested) : "—",
        a.running ? "RUNNING" : "idle",
      ]);
    }
    writeTable(rows);
  }

  return fresh ? 0 : 2;
}

function isFresh(hb: Heartbeat): boolean {
  const ageMs = Date.now() - Date.parse(hb.lastHeartbeatAt);
  // Heartbeat writes every 60s by default; 3× that is a reasonable
  // staleness threshold.
  return ageMs < 180_000;
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function humanAgo(ms: number): string {
  return `${humanDuration(ms)} ago`;
}

function writeTable(rows: string[][]): void {
  const cols = rows[0]!.length;
  const widths = new Array(cols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      widths[i] = Math.max(widths[i], (row[i] ?? "").length);
    }
  }
  for (const [ri, row] of rows.entries()) {
    const line = row.map((c, i) => c.padEnd(widths[i])).join("  ");
    process.stdout.write(`${line}\n`);
    if (ri === 0) {
      process.stdout.write(
        widths.map((w) => "-".repeat(w)).join("  ") + "\n",
      );
    }
  }
}
