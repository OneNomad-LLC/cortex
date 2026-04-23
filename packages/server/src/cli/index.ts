import { runDashboard } from "./dashboard.js";
import { autoLoadDotEnv } from "./dotenv.js";
import { runDoctor } from "./doctor.js";
import { runGoogleLogin } from "./google-login.js";
import { runInit } from "./init.js";
import {
  runAdd,
  runConfigure,
  runDisable,
  runList,
} from "./module-commands.js";
import { runSmoke } from "./smoke.js";
import { runStatus } from "./status.js";
import { runSyncCli } from "./sync.js";
import { startServer } from "../mcp/server.js";

const HELP = `cortex — work-knowledge MCP server and CLI

Usage:
  cortex <command> [options]

Commands:
  init                       Interactive setup wizard (first run).
  start                      Boot the Cortex MCP server over stdio.
  status                     Show daemon heartbeat (uptime, adapter stats).
  doctor [--connect]         Pre-flight checks: config, secrets, tokens, taxonomy.
                               --connect also probes Engram + Postgres live.
  smoke                      Run a live LLM probe against every enabled provider.
  dashboard [--port N]       Launch the local web dashboard (Next.js). Pairs
                               with \`cortex start --api\`.
  sync <adapter> [flags]     Run one adapter's full ingestion cycle once.
                               --since=ISO  only items updated after this date
                               --limit=N    cap items processed
                               --dry-run    don't write to memory

  modules                    List all installable module wizards.
  add <module>               Enable a module via guided wizard.
  configure <module>         Re-run a module's wizard (current values as defaults).
  disable <module>           Turn off an already-configured module.

  google-login               Run the Google OAuth flow (for gmail/calendar/drive).

  help                       Show this message.

Environment:
  CORTEX_CONFIG_PATH   Path to cortex.yaml (default: ./config/cortex.yaml)
  ENGRAM_MCP_URL       Override Engram MCP endpoint
  PERSONA_MCP_URL      Override Persona MCP endpoint
  LOG_LEVEL            debug | info (default info)

First run:
  cortex init
`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  // Every subcommand except `help`/`init` needs .env loaded. `init` loads
  // it explicitly after writing.
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    autoLoadDotEnv();
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    case "init":
      return runInit({ args: rest });

    case "doctor":
      return runDoctor(rest);

    case "smoke":
      return runSmoke();

    case "dashboard":
      return runDashboard(rest);

    case "status":
      return runStatus();

    case "sync":
      return runSyncCli(rest);

    case "modules":
      return runList();

    case "add":
      return runAdd(rest);

    case "configure":
      return runConfigure(rest);

    case "disable":
      return runDisable(rest);

    case "google-login":
      return runGoogleLogin(rest);

    case "start":
      await startServer();
      return 0;

    default:
      process.stderr.write(`cortex: unknown command '${command}'\n\n`);
      process.stdout.write(HELP);
      return 2;
  }
}
