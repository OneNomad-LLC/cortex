import os from "node:os";
import path from "node:path";
import {
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import type { Logger } from "@onenomad/przm-cortex-core";
import { getSharedLogBus, type LogLine } from "./log-bus.js";

/**
 * Resolve the runtime log file path. Lives at <cortex-home>/logs/runtime.log
 * so logs persist across MCP restarts and survive Pyre/Claude Desktop
 * sessions. Honors PRZM_CORTEX_HOME for the docker / non-default case;
 * falls back to ~/.cortex which matches stateFilePath()'s root.
 *
 * Resolved once at module load; the directory is created lazily on
 * first append so a fresh install doesn't have to pre-create it.
 */
function resolveRuntimeLogPath(): string {
  const home = process.env.PRZM_CORTEX_HOME ?? path.join(os.homedir(), ".cortex");
  return path.join(home, "logs", "runtime.log");
}
const RUNTIME_LOG_PATH = resolveRuntimeLogPath();
let _logsDirEnsured = false;
function appendToDisk(line: string): void {
  try {
    if (!_logsDirEnsured) {
      const dir = path.dirname(RUNTIME_LOG_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      _logsDirEnsured = true;
    }
    appendFileSync(RUNTIME_LOG_PATH, line);
  } catch {
    // Disk-write failures must never break logging itself; the in-memory
    // bus + stderr stream still carry the line. A future tail tool can
    // surface "log file unwritable" as its own problem.
  }
}

/**
 * Minimal console logger. Structured enough for grep; swap for pino/winston
 * when ops need it.
 *
 * Every line goes three places:
 *   1. stderr (Docker log driver, parent process capture)
 *   2. in-memory ring buffer (dashboard /api/logs/stream SSE)
 *   3. <cortex-home>/logs/runtime.log (persistent across restarts —
 *      consumed by the recent_logs MCP tool so Pyre's Activity tab
 *      survives session boundaries)
 */
export function createLogger(
  bindings: Record<string, unknown> = {},
): Logger {
  const bus = getSharedLogBus();
  const log = (level: string, message: string, meta?: Record<string, unknown>): void => {
    const line: LogLine = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...bindings,
      ...meta,
    };
    const serialized = `${JSON.stringify(line)}\n`;
    // Always stderr. The MCP stdio transport owns stdout for protocol framing;
    // writing logs there would corrupt it.
    process.stderr.write(serialized);
    bus.append(line);
    appendToDisk(serialized);
  };

  return {
    debug(msg, meta) {
      if (process.env.LOG_LEVEL === "debug") log("debug", msg, meta);
    },
    info(msg, meta) {
      log("info", msg, meta);
    },
    warn(msg, meta) {
      log("warn", msg, meta);
    },
    error(msg, meta) {
      log("error", msg, meta);
    },
    child(extra) {
      return createLogger({ ...bindings, ...extra });
    },
  };
}
