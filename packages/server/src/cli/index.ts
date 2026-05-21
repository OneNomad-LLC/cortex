import { runBackfillCli } from "./backfill.js";
import { runDockerDown, runDockerLogs, runDockerUp } from "./docker.js";
import { autoLoadDotEnv } from "./dotenv.js";
import { runDoctor } from "./doctor.js";
import { runImportMeeting } from "./import-meeting.js";
import { runGithubLogin } from "./github-login.js";
import { runInit } from "./init.js";
import { runLogin } from "../auth/login.js";
import { runLogout } from "./logout.js";
import {
  runAdd,
  runConfigure,
  runDisable,
  runList,
} from "./module-commands.js";
import { runModuleCommand } from "./module-install.js";
import { runServe } from "./serve.js";
import { runSmoke } from "./smoke.js";
import { runStatus } from "./status.js";
import { runSyncCli } from "./sync.js";
import { runTenant } from "./tenant.js";
import { runUse } from "./use.js";
import { runWhoami } from "./whoami.js";
import { runWorker } from "./worker.js";
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
  serve                      Run the stdio MCP server in the current mode.
                               Cloud mode: proxies to the remote Cortex.
                               Local mode: same as \`cortex start\`. Use
                               in MCP client configs:
                                 claude mcp add cortex cortex -- serve

  login <pyre-web-url>       Device-code login to Cortex Cloud. Opens a
                               browser to confirm; stores credentials at
                               ~/.pyre/credentials.json with file perms
                               0600 (shared with engram-mcp + persona-mcp;
                               one login per machine signs all three in).
                               URL required — pass positional, --server
                               <url>, or PYRE_API_URL env. No defaults.
  logout                     Clear cortex section of stored credentials.
                               Engram/persona credentials in the same
                               file are preserved.
  whoami                     Print the active mode + endpoint. Never
                               echoes the bearer.
  use local|cloud            Flip the mode flag. Cloud requires prior
                               login (or PRZM_CORTEX_MCP_URL + PRZM_CORTEX_MCP_TOKEN).
  tenant list                List all tenants signed in on this machine.
  tenant switch <slug>       Change the active tenant. \`cortex serve\` uses
                               whichever tenant is active. Pure file edit,
                               no network call.
  tenant refresh             Re-fetch tenant list from pyre-web. Useful
                               after an admin adds/removes you from a
                               tenant without going through \`cortex login\`.

  up [-- args...]            Start the Docker stack in the background
                               (wraps \`docker compose up -d\`). Adds
                               --foreground to run attached.
  down [-- args...]          Stop the Docker stack (wraps \`docker compose down\`).
  logs [-- args...]          Tail Docker stack logs (wraps \`docker compose logs -f\`).

  status                     Show daemon heartbeat (uptime, adapter stats).
  doctor [--connect]         Pre-flight checks: config, secrets, tokens, taxonomy.
                               --connect also probes Engram + Postgres live.
  smoke                      Run a live LLM probe against every enabled provider.
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

  github-login [--scopes <csv>]
                             Device-flow OAuth with GitHub. No PAT paste needed.

  help                       Show this message.

Environment:
  PRZM_CORTEX_CONFIG_PATH   Path to cortex.yaml (default: ./config/cortex.yaml)
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

    case "start":
      await startServer();
      return 0;

    case "serve":
      return runServe(rest);

    case "login":
      return runLogin(rest);

    case "logout":
      return runLogout(rest);

    case "whoami":
      return runWhoami(rest);

    case "use":
      return runUse(rest);

    case "tenant":
      return runTenant(rest);

    case "up":
      return runDockerUp(rest);

    case "down":
      return runDockerDown(rest);

    case "logs":
      return runDockerLogs(rest);

    case "worker":
      return runWorker();

    default:
      process.stderr.write(`cortex: unknown command '${command}'\n\n`);
      process.stdout.write(HELP);
      return 2;
  }
}
