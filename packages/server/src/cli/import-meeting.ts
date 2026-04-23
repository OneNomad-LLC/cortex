import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ClassifiedItem, SourceType } from "@onenomad/cortex-core";
import { createMeetingPipeline } from "@onenomad/cortex-pipeline-meeting";
import { loadCortexConfig } from "../config.js";
import { createMemoryClient } from "../clients/memory.js";
import { createLogger } from "../logger.js";
import { buildLLMRouter } from "../registry/providers.js";
import { buildPipelineContext } from "../sync.js";
import { loadTaxonomy } from "../taxonomy.js";
import { resolveConfigPath } from "./config-path.js";
import { findRepoRoot, loadDotEnv } from "./dotenv.js";

/**
 * Pure-text transcript importer — the workaround for Loom + any other
 * source without API access. Reads a file (VTT, SRT, or plain text /
 * markdown), strips transcript markup, and runs the content through
 * `@onenomad/cortex-pipeline-meeting` exactly as if the meeting had been fetched
 * by an API adapter.
 *
 * Why a dedicated command instead of the Obsidian adapter: Obsidian
 * files route through pipeline-doc, which chunks but doesn't extract
 * decisions + action items + generate a brief. Meetings deserve the
 * meeting pipeline.
 */
export interface ImportMeetingArgs {
  file: string;
  project?: string;
  dateIso?: string;
  attendees?: string[];
  title?: string;
  source?: string;
  sourceUrl?: string;
  dryRun?: boolean;
}

export async function runImportMeeting(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }
  const opts = parsed.opts;

  const repoRoot = findRepoRoot(process.cwd());
  loadDotEnv(repoRoot);

  const logger = createLogger({ component: "import-meeting" });
  const configPath = resolveConfigPath();
  const cfg = await loadCortexConfig(configPath).catch((err) => {
    process.stderr.write(
      `cortex import meeting: couldn't load config at ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  });
  if (!cfg) return 1;

  // 1. Read and normalize transcript
  const absPath = path.resolve(opts.file);
  const raw = await readFile(absPath, "utf8").catch((err) => {
    process.stderr.write(
      `cortex import meeting: can't read ${absPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  });
  if (raw === undefined) return 1;

  const stats = await stat(absPath);
  const transcript = normalizeTranscript(raw, path.extname(absPath).toLowerCase());
  if (transcript.trim().length === 0) {
    process.stderr.write(
      `cortex import meeting: no text extracted from ${absPath}. Is it a valid transcript?\n`,
    );
    return 1;
  }

  // 2. Resolve project + attendees via taxonomy
  const taxonomy = await loadTaxonomy({
    projectsPath: path.join(repoRoot, "config", "projects.yaml"),
    peoplePath: path.join(repoRoot, "config", "people.yaml"),
  });

  let projectSlug: string | undefined = opts.project;
  if (projectSlug) {
    const resolved = taxonomy.findProject(projectSlug);
    if (!resolved) {
      process.stderr.write(
        `cortex import meeting: no project matched '${opts.project}'. Try \`cortex add projects\` first or pass an existing slug.\n`,
      );
      return 2;
    }
    projectSlug = resolved.slug;
  }

  const authorSlugs: string[] = [];
  for (const raw of opts.attendees ?? []) {
    const person = taxonomy.findPerson(raw);
    authorSlugs.push(person ? person.slug : raw);
  }

  // 3. Build ClassifiedItem and pipeline context
  const meetingDate = opts.dateIso
    ? new Date(opts.dateIso)
    : stats.mtime;
  if (Number.isNaN(meetingDate.getTime())) {
    process.stderr.write(
      `cortex import meeting: --date must be a valid ISO 8601 date, got '${opts.dateIso}'.\n`,
    );
    return 2;
  }

  const title = opts.title ?? defaultTitle(absPath);
  const hashPart = createHash("sha1")
    .update(`${absPath}:${meetingDate.toISOString()}`)
    .digest("hex")
    .slice(0, 12);
  const sourceLabel = opts.source ?? "manual";

  const item: ClassifiedItem = {
    sourceId: `${sourceLabel}:meeting:${hashPart}`,
    // Trust the user's --source if they named a known adapter label
    // (e.g. `loom` for a Loom transcript). Anything else becomes
    // `manual`, which is a first-class SourceType for this case.
    sourceType: KNOWN_SOURCES.has(sourceLabel)
      ? (sourceLabel as SourceType)
      : "manual",
    // sourceUrl is required by NormalizedItem. If the user didn't pass
    // one, fall back to a stable file:// URI so metadata validation
    // passes and the brief can still link back to the original file.
    sourceUrl: opts.sourceUrl ?? pathToFileUrl(absPath),
    title,
    content: transcript,
    contentType: "meeting",
    createdAt: meetingDate,
    updatedAt: meetingDate,
    authors: authorSlugs,
    rawMetadata: {
      manualImport: true,
      originalPath: absPath,
      originalBytes: Buffer.byteLength(raw, "utf8"),
      transcriptBytes: Buffer.byteLength(transcript, "utf8"),
    },
    projects: projectSlug ? [projectSlug] : [],
    confidence: projectSlug ? 1.0 : 0.5,
    classificationMethod: "manual",
  };

  // 4. Wire LLM + memory
  const { router: llmRouter } = await buildLLMRouter({
    cfg,
    env: process.env,
    logger,
  });
  const memoryBoot = await createMemoryClient({
    memory: cfg.memory,
    llmRouter,
    logger,
  });
  const engram = memoryBoot.client;

  const abortController = new AbortController();
  const traceId = randomUUID();
  const pipelineCtx = buildPipelineContext({
    logger,
    traceId,
    signal: abortController.signal,
    llmRouter,
  });

  // 5. Run pipeline
  process.stdout.write(
    `\ncortex import meeting\n=====================\n` +
      `file:      ${absPath}\n` +
      `title:     ${title}\n` +
      `date:      ${meetingDate.toISOString()}\n` +
      `project:   ${projectSlug ?? "(unset — classifier confidence 0.5)"}\n` +
      `attendees: ${authorSlugs.join(", ") || "(none)"}\n` +
      `source:    ${sourceLabel}${opts.sourceUrl ? ` (${opts.sourceUrl})` : ""}\n` +
      `bytes:     ${item.rawMetadata.transcriptBytes} transcript / ${item.rawMetadata.originalBytes} raw\n\n` +
      `Running meeting pipeline (extract → synthesize → brief)...\n`,
  );

  let memories;
  try {
    const pipeline = createMeetingPipeline();
    memories = await pipeline.run(item, pipelineCtx);
  } catch (err) {
    process.stderr.write(
      `cortex import meeting: pipeline failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    await engram.shutdown().catch(() => undefined);
    return 1;
  }

  process.stdout.write(`Pipeline emitted ${memories.length} memor${memories.length === 1 ? "y" : "ies"}.\n`);

  if (opts.dryRun) {
    process.stdout.write(
      "\n--dry-run set — nothing written to Engram. Preview:\n\n",
    );
    for (const mem of memories) {
      const preview = mem.content.length > 200
        ? `${mem.content.slice(0, 200)}…`
        : mem.content;
      process.stdout.write(
        `  [${String(mem.metadata.type ?? "?")}] ${preview}\n`,
      );
    }
    await engram.shutdown().catch(() => undefined);
    return 0;
  }

  // 6. Ingest
  let ingested = 0;
  for (const mem of memories) {
    await engram.ingest({ content: mem.content, metadata: mem.metadata });
    ingested += 1;
  }
  await engram.shutdown().catch(() => undefined);

  process.stdout.write(
    `\nIngested ${ingested} memor${ingested === 1 ? "y" : "ies"} to Engram.\n` +
      (projectSlug
        ? `Try \`my_action_items\` or \`catch_me_up_on_meeting\` in Claude to see it.\n`
        : `Warning: no project tag. Run \`cortex add projects\` then re-import with --project.\n`),
  );
  return 0;
}

const KNOWN_SOURCES = new Set<string>([
  "loom",
  "google_meet",
  "confluence",
  "notion",
  "google_drive",
  "jira",
  "linear",
  "bitbucket",
  "github",
  "calendar",
  "slack",
  "teams",
  "email",
  "obsidian",
  "manual",
]);

const USAGE = `Usage:
  cortex import meeting <file> [options]

Options:
  --project <slug>       Project slug from projects.yaml (strongly recommended).
  --date <ISO>           Meeting date. Default: file mtime.
  --attendees <csv>      Comma-separated person slugs, names, or emails.
  --title <string>       Meeting title. Default: derived from filename.
  --source <string>      Source label. Default: "manual".
  --source-url <url>     Link back to the source (e.g. a Loom share URL).
  --dry-run              Run extraction and preview; skip Engram write.

Accepted file types: .vtt, .srt, .md, .txt (plain transcript text).

Examples:
  cortex import meeting ./loom-kickoff.vtt --project alpha \\
    --date 2026-04-22 --attendees matt,alex \\
    --source loom --source-url https://www.loom.com/share/xxxxxxxx
  cortex import meeting notes.md --project alpha --dry-run`;

function parseArgs(args: readonly string[]):
  | { opts: ImportMeetingArgs }
  | { error: string } {
  const opts: ImportMeetingArgs = { file: "" };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    const [key, inline] = a.startsWith("--") && a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, undefined];
    const readValue = (flag: string): string | undefined => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return undefined;
      }
      i += 1;
      return next;
    };
    switch (key) {
      case "--project": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires a value` };
        opts.project = v;
        break;
      }
      case "--date": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires an ISO date` };
        opts.dateIso = v;
        break;
      }
      case "--attendees": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires a comma-separated list` };
        opts.attendees = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      }
      case "--title": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires a value` };
        opts.title = v;
        break;
      }
      case "--source": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires a value` };
        opts.source = v;
        break;
      }
      case "--source-url": {
        const v = readValue(key);
        if (!v) return { error: `${key} requires a URL` };
        opts.sourceUrl = v;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        return { error: "" };
      default:
        if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
        positional.push(a);
        break;
    }
  }
  if (positional.length === 0) return { error: "missing <file>" };
  if (positional.length > 1) {
    return { error: `too many positional args: ${positional.join(" ")}` };
  }
  opts.file = positional[0]!;
  return { opts };
}

/**
 * Strip transcript markup from VTT / SRT, pass plain text through.
 * The goal isn't pretty-printing — it's feeding the meeting pipeline
 * the spoken words without timecodes confusing the extractor.
 */
export function normalizeTranscript(raw: string, ext: string): string {
  switch (ext) {
    case ".vtt":
      return stripVtt(raw);
    case ".srt":
      return stripSrt(raw);
    default:
      return raw;
  }
}

function stripVtt(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    // Header + empty separators
    if (/^WEBVTT/i.test(line)) continue;
    if (/^NOTE\b/i.test(line)) continue;
    if (/^STYLE\b/i.test(line)) continue;
    if (line.trim() === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    // Timecode lines: "00:00:01.000 --> 00:00:04.000"
    if (/-->/.test(line)) continue;
    // Cue identifiers (often numeric or kebab-id alone on a line)
    if (/^[\w-]+$/.test(line) && !/\s/.test(line)) {
      // Ambiguous — could be a speaker tag or a cue id. If the next
      // non-empty line is a timecode, treat this as a cue id.
      continue;
    }
    // Strip inline VTT tags like <v Speaker> and </v>, <c.red>, <00:00:01.500>.
    out.push(line.replace(/<[^>]+>/g, "").trim());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripSrt(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip SRT sequence numbers (purely numeric lines).
    if (/^\d+$/.test(trimmed)) continue;
    // Skip timecode lines.
    if (/-->/.test(trimmed)) continue;
    out.push(line.replace(/<[^>]+>/g, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function defaultTitle(absPath: string): string {
  const base = path.basename(absPath, path.extname(absPath));
  return base.replace(/[-_]+/g, " ").trim() || "Imported meeting";
}

/**
 * Build a `file://` URL from an absolute path that round-trips across
 * platforms. Windows paths use backslashes and a drive letter; Node's
 * `url.pathToFileURL` handles both, so we delegate.
 */
function pathToFileUrl(absPath: string): string {
  // Lazy import to avoid a top-level import just for this one helper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return new URL(`file:///${absPath.replace(/\\/g, "/").replace(/^\//, "")}`)
    .toString();
}
