import type { Logger } from "@onenomad/cortex-core";

/**
 * Minimal console logger. Structured enough for grep; swap for pino/winston
 * when ops need it.
 */
export function createLogger(
  bindings: Record<string, unknown> = {},
): Logger {
  const log = (level: string, message: string, meta?: Record<string, unknown>): void => {
    const line = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...bindings,
      ...meta,
    };
    // Always stderr. The MCP stdio transport owns stdout for protocol framing;
    // writing logs there would corrupt it.
    process.stderr.write(`${JSON.stringify(line)}\n`);
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
