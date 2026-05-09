import { runBackfillCli } from "./backfill.js";
import { runDashboard } from "./dashboard.js";
import { runNotifyCli } from "./notify.js";
import { runDockerDown, runDockerLogs, runDockerUp } from "./docker.js";
import { autoLoadDotEnv } from "./dotenv.js";
import { runDoctor } from "./doctor.js";
import { runImportMeeting } from "./import-meeting.js";
import { runGithubLogin } from "./github-login.js";
import { runInit } from "./init.js";
import {
  runAdd,
  runConfigure,
  runDisable,
  runList,
} from "./module-commands.js";
import { runModuleCommand } from "./module-install.js";
import { runSmoke } from "./smoke.js";
import { runStatus } from "./status.js";
import { runSyncCli } from "./sync.js";
import { runWorkspace } from "./workspace/command.js";
import { startServer } from "../mcp/server.js";

const HELP = `cortex — work-knowledge MCP server and CLI

Usage:
  cortex <command> [options]

Commands:
  init                       Interactive setup wizard (first run).
  start                      Boot Cortex in the foreground (stdio MCP by
                               default; dev / local-only). Ctrl+C to stop.
                               For a daemon, use \`cortex up\`.

  up [-- args...]            Start the Docker stack in the background
                               (wraps \`docker compose up -d\`). Adds
                               --foreground to run attached.
  down [-- args...]          Stop the Docker stack (wraps \`docker compose down\`).
  logs [-- args...]          Tail Docker stack logs (wraps \`docker compose logs -f\`).

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
  import meeting <file>      Run a transcript through the meeting pipeline.
                               --project=<slug> --date=<ISO> --attendees=<csv>
                               --source-url=<url> --dry-run

  modules                    List all installable module wizards.
  add <module>               Enable a module via guided wizard.
  configure <module>         Re-run a module's wizard (current values as defaults).
  disable <module>           Turn off an already-configured module.

  module install <src>       Install a private module (git URL or local path).
                               --name=<slug>   override module name
                               --no-build      skip pnpm install + build
                               --path-only     register existing dir as-is
                               --native        write host paths (non-Docker setups)
  module list                Show installed private modules.
  module remove <name>       Unregister a private module (keeps files).

  workspace <sub>            Manage named config bundles. Subcommands:
                               list, current, add, switch, remove, rename.
                               Each workspace has its own config/ and .env.

  backfill workspace --slug <slug>
                             Audit how many memories lack a workspace stamp
                             and would benefit from re-ingest under <slug>.
                             --limit=N (default 1000), --query=<text>,
                             --dry-run. Audit-only today; the write path
                             requires an engram-side memory_add_tag follow-up.

  notify <flavor> [--dry-run] [--channel=@user]
                             Manually fire a Prong B push notification —
                             flavor is morning|pre-meeting|eod. Slack DM
                             via SLACK_TOKEN env. Idempotency keyed per
                             day (or per minute for pre-meeting manual
                             triggers). Cron integration is a separate
                             follow-up; this is the foundation.

  github-login [--scopes <csv>]
                             Device-flow OAuth with GitHub. No PAT paste needed.

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

    case "import": {
      const [sub, ...subArgs] = rest;
      if (sub === "meeting") return runImportMeeting(subArgs);
      process.stderr.write(
        `cortex: unknown import subcommand '${sub ?? "(missing)"}'. Try: cortex import meeting <file>\n`,
      );
      return 2;
    }

    case "modules":
      return runList();

    case "module":
      return runModuleCommand(rest);

    case "add":
      return runAdd(rest);

    case "configure":
      return runConfigure(rest);

    case "disable":
      return runDisable(rest);

    case "github-login":
      return runGithubLogin(rest);

    case "workspace":
      return runWorkspace(rest);

    case "backfill":
      return runBackfillCli(rest);

    case "notify":
      return runNotifyCli(rest);

    case "start":
      await startServer();
      return 0;

    case "up":
      return runDockerUp(rest);

    case "down":
      return runDockerDown(rest);

    case "logs":
      return runDockerLogs(rest);

    default:
      process.stderr.write(`cortex: unknown command '${command}'\n\n`);
      process.stdout.write(HELP);
      return 2;
  }
}
