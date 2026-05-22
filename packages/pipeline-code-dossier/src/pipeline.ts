import path from "node:path";
import { defaultTrustForSource } from "@onenomad/przm-cortex-core";
import type { MemoryMetadata, SourceType } from "@onenomad/przm-cortex-core";
import type {
  Pipeline,
  PipelineContext,
  PipelineMemory,
} from "@onenomad/przm-cortex-pipeline-core";
import { loadPrompt, renderPrompt } from "./prompts.js";
import {
  buildStructuralPayload,
  renderAdrList,
  renderAdrsForPrompt,
  renderEntryPointsForPrompt,
} from "./structural.js";
import type {
  AdrFile,
  CodeDossierInput,
  CodeDossierPipelineOptions,
  EntryPointFile,
  StructuralPayload,
} from "./types.js";

/** Canonical, fixed source-id for the brief memory. */
const DOSSIER_SOURCE_ID_SUFFIX = "dossier";

/**
 * Build the code dossier pipeline.
 *
 * The 3 passes:
 *   1. Structural   — pure file walk, no LLM.
 *   2. Synthesis    — LLM produces the dossier markdown.
 *   3. Brief        — LLM polishes the dossier into final form.
 *
 * When `ctx.llm` is undefined the pipeline degrades gracefully: it skips
 * passes 2 and 3 and emits a single `brief`-typed memory holding the raw
 * structural payload (so the caller still has something searchable, and
 * a future re-run with an LLM upgrades quality without losing source-id
 * stability).
 */
export function createCodeDossierPipeline(
  opts: CodeDossierPipelineOptions = {},
): Pipeline<CodeDossierInput, PipelineMemory> {
  return {
    id: "@onenomad/przm-cortex-pipeline-code-dossier",
    version: "0.5.1",

    async run(
      input: CodeDossierInput,
      ctx: PipelineContext,
    ): Promise<PipelineMemory[]> {
      const structural = await buildStructuralPayload(input, opts);

      // --- Pass 2 + 3 (synthesis + brief polish) -----------------------
      // When no LLM is available we skip both. The structural payload
      // alone yields a single brief memory — the caller can re-ingest
      // later once an LLM is wired up.
      let dossierMd: string;
      let llmAvailable: boolean;
      if (ctx.llm) {
        llmAvailable = true;
        try {
          const synthesized = await runSynthesis(structural, ctx);
          dossierMd = opts.skipBriefPolish
            ? synthesized
            : await runBriefPolish(structural, synthesized, ctx);
        } catch (err) {
          // Hard fail in either LLM pass: log and degrade to the raw
          // structural rendering. Better to ship a low-signal memory
          // than to lose the run entirely.
          ctx.logger.warn("pipeline-code-dossier.llm.failed", {
            traceId: ctx.traceId,
            error: err instanceof Error ? err.message : String(err),
          });
          llmAvailable = false;
          dossierMd = renderStructuralAsDossier(structural);
        }
      } else {
        llmAvailable = false;
        ctx.logger.info("pipeline-code-dossier.no_llm", {
          hint: "no local LLM — emitting raw structural payload as the single brief memory",
        });
        dossierMd = renderStructuralAsDossier(structural);
      }

      const memories: PipelineMemory[] = [];

      // (1) The brief — always emitted.
      memories.push(buildBriefMemory(input, structural, dossierMd, ctx.traceId));

      // (2/3) ADR + entry-point memories — only when synthesis ran. The
      // graceful-degradation mode emits ONLY the brief, per the design
      // brief.
      if (llmAvailable) {
        for (const adr of structural.adrFiles) {
          memories.push(buildAdrMemory(input, adr, ctx.traceId));
        }
        for (const ep of structural.entryPoints) {
          memories.push(buildReferenceMemory(input, ep, ctx.traceId));
        }
      }

      return memories;
    },
  };
}

/** Default export so callers can `import codeDossierPipeline from ...` with default opts. */
export const codeDossierPipeline: Pipeline<CodeDossierInput, PipelineMemory> =
  createCodeDossierPipeline();

// -- Passes ---------------------------------------------------------------

async function runSynthesis(
  structural: StructuralPayload,
  ctx: PipelineContext,
): Promise<string> {
  if (!ctx.llm) throw new Error("pipeline-code-dossier: ctx.llm required");
  const tmpl = await loadPrompt("synthesis.md");
  const prompt = renderPrompt(tmpl, {
    REPO_NAME: structural.repoName,
    README: structural.readme || "(no README in repo)",
    ARCHITECTURE: structural.architecture || "(no ARCHITECTURE.md in repo)",
    CLAUDE_MD: structural.claudeMd || "(no CLAUDE.md in repo)",
    AGENTS_MD: structural.agentsMd || "(no AGENTS.md in repo)",
    DECISIONS: structural.decisions || "(no docs/DECISIONS.md in repo)",
    ADR_FILES: renderAdrsForPrompt(structural.adrFiles) || "(no ADRs in repo)",
    ROADMAP: structural.roadmap || "(no ROADMAP in repo)",
    MIGRATION: structural.migration || "(no MIGRATION in repo)",
    CHANGELOG: structural.changelog || "(no CHANGELOG in repo)",
    MANIFEST: structural.manifest?.content || "(no recognized manifest)",
    MONOREPO_MANIFEST:
      structural.monorepoManifest?.content || "(not a monorepo)",
    ENTRY_POINTS:
      renderEntryPointsForPrompt(structural.entryPoints) ||
      "(no entry points sampled)",
  });
  const raw = await ctx.llm.complete({
    task: "synthesis",
    prompt,
    temperature: 0,
    maxTokens: 4096,
  });
  return stripDossierPreamble(raw);
}

async function runBriefPolish(
  structural: StructuralPayload,
  synthesized: string,
  ctx: PipelineContext,
): Promise<string> {
  if (!ctx.llm) throw new Error("pipeline-code-dossier: ctx.llm required");
  const tmpl = await loadPrompt("brief.md");
  const prompt = renderPrompt(tmpl, {
    REPO_NAME: structural.repoName,
    ADR_LIST: renderAdrList(structural.adrFiles),
    ENTRY_POINT_PATHS:
      structural.entryPoints.map((ep) => `- ${ep.path}`).join("\n") ||
      "(none)",
    DOSSIER: synthesized,
  });
  const raw = await ctx.llm.complete({
    task: "brief",
    prompt,
    temperature: 0,
    maxTokens: 4096,
  });
  return stripDossierPreamble(raw);
}

/**
 * Trim conversational preambles like "Here is the polished dossier:\n\n"
 * that models occasionally emit despite the prompt's instructions. The
 * first markdown H1 is the dossier's real start.
 */
export function stripDossierPreamble(raw: string): string {
  const trimmed = raw.trim();
  const h1 = /^#\s+/m.exec(trimmed);
  if (h1 && h1.index > 0) return trimmed.slice(h1.index).trim();
  return trimmed;
}

// -- Memory construction --------------------------------------------------

function buildBriefMemory(
  input: CodeDossierInput,
  structural: StructuralPayload,
  dossier: string,
  traceId: string | undefined,
): PipelineMemory {
  const meta = buildBaseMetadata(input, traceId, ["dossier"]);
  return {
    content: dossier,
    metadata: {
      ...meta,
      type: "brief",
      source_id: `${input.sourceIdPrefix}:${DOSSIER_SOURCE_ID_SUFFIX}`,
      title: `${structural.repoName} architectural dossier`,
    },
  };
}

function buildAdrMemory(
  input: CodeDossierInput,
  adr: AdrFile,
  traceId: string | undefined,
): PipelineMemory {
  const meta = buildBaseMetadata(input, traceId, ["adr", "dossier"]);
  const title = extractAdrTitle(adr) ?? adr.filename.replace(/\.(md|markdown)$/i, "");
  return {
    content: adr.content,
    metadata: {
      ...meta,
      type: "decision",
      source_id: `${input.sourceIdPrefix}:adr:${adr.filename}`,
      title,
    },
  };
}

function buildReferenceMemory(
  input: CodeDossierInput,
  ep: EntryPointFile,
  traceId: string | undefined,
): PipelineMemory {
  const tag = ep.path.startsWith("bin/")
    ? "entrypoint"
    : ep.path.startsWith("packages/")
      ? "api-surface"
      : "api-surface";
  const meta = buildBaseMetadata(input, traceId, [tag, "dossier"]);
  const header = `> Public API surface for \`${ep.path}\`.\n> Captured by pipeline-code-dossier; verbatim file contents follow.\n\n`;
  return {
    content: `${header}${ep.content}`,
    metadata: {
      ...meta,
      type: "reference",
      source_id: `${input.sourceIdPrefix}:api:${ep.path}`,
      title: `Public API: ${ep.path}`,
    },
  };
}

function extractAdrTitle(adr: AdrFile): string | null {
  const match = /^\s*#+\s+(.+?)\s*$/m.exec(adr.content);
  return match?.[1] ?? null;
}

// -- Metadata -------------------------------------------------------------

function buildBaseMetadata(
  input: CodeDossierInput,
  traceId: string | undefined,
  extraTags: ReadonlyArray<string>,
): MemoryMetadata {
  const source = inferSourceType(input.sourceIdPrefix);
  const trustDefaults = defaultTrustForSource(source);
  const tags = mergeTags(input.tags, extraTags);
  const now = new Date().toISOString();
  const sourceUrl = input.sourceUrl ?? syntheticSourceUrl(input);

  const meta: MemoryMetadata = {
    domain: "work",
    source,
    source_id: input.sourceIdPrefix, // overwritten per-memory below
    source_url: sourceUrl,
    type: "brief", // overwritten per-memory below
    people: [],
    date: now,
    confidence: 0.9,
    sensitivity: trustDefaults.sensitivity,
    trust: trustDefaults.trust,
  };
  if (input.project) meta.project = input.project;
  if (tags.length > 0) meta.tags = tags;
  if (traceId) meta.trace_id = traceId;
  return meta;
}

/**
 * Map the caller's source-id prefix to a `SourceType`. Examples:
 *   - "github:OneNomad-LLC/cortex"    -> "github"
 *   - "bitbucket:team/repo"           -> "bitbucket"
 *   - "manual:cortex"                 -> "manual"
 *   - "git:/local/path"               -> "manual"   (no enum value for plain git)
 *   - "anything-without-a-colon"      -> "manual"
 */
export function inferSourceType(prefix: string): SourceType {
  const colon = prefix.indexOf(":");
  if (colon < 0) return "manual";
  const head = prefix.slice(0, colon).toLowerCase();
  switch (head) {
    case "github":
      return "github";
    case "bitbucket":
      return "bitbucket";
    case "gitlab":
      // No "gitlab" in the source-type enum; treat as manual rather than
      // misattribute. Adapter-side will route through the right ingest.
      return "manual";
    default:
      return "manual";
  }
}

function syntheticSourceUrl(input: CodeDossierInput): string {
  // The metadata schema requires a parseable URL. When the caller didn't
  // give us one we synthesise a placeholder that round-trips through
  // `new URL(...)` cleanly.
  const safe = encodeURIComponent(
    input.sourceIdPrefix || path.basename(path.resolve(input.repoPath)),
  );
  return `https://repo.local/${safe}`;
}

function mergeTags(
  callerTags: ReadonlyArray<string> | undefined,
  extra: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...(callerTags ?? []), ...extra]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// -- Graceful-degradation renderer ---------------------------------------

/**
 * When no LLM is available the pipeline still has to produce *something*
 * that's worth a brief memory. This renders the raw structural payload
 * as a minimally-structured markdown doc.
 *
 * It is intentionally not as good as the synthesized dossier — a future
 * re-ingest with an LLM configured will upgrade this in place (same
 * source_id, dedup via the memory backend's idempotency contract).
 */
export function renderStructuralAsDossier(s: StructuralPayload): string {
  const sections: string[] = [];
  sections.push(`# ${s.repoName} architectural dossier`);
  sections.push(
    "_Generated without an LLM — this is the raw structural extraction. Re-ingest with a configured LLM to upgrade to a synthesised dossier._",
  );

  if (s.readme) sections.push("## README\n\n" + s.readme);
  if (s.architecture) sections.push("## ARCHITECTURE.md\n\n" + s.architecture);
  if (s.claudeMd) sections.push("## CLAUDE.md\n\n" + s.claudeMd);
  if (s.agentsMd) sections.push("## AGENTS.md\n\n" + s.agentsMd);
  if (s.decisions) sections.push("## docs/DECISIONS.md\n\n" + s.decisions);
  if (s.roadmap) sections.push("## ROADMAP\n\n" + s.roadmap);
  if (s.migration) sections.push("## MIGRATION\n\n" + s.migration);
  if (s.changelog) sections.push("## CHANGELOG\n\n" + s.changelog);

  if (s.manifest) {
    sections.push(`## Manifest (${s.manifest.filename})\n\n\`\`\`\n${s.manifest.content}\n\`\`\``);
  }
  if (s.monorepoManifest) {
    sections.push(
      `## Monorepo manifest (${s.monorepoManifest.filename})\n\n\`\`\`\n${s.monorepoManifest.content}\n\`\`\``,
    );
  }

  if (s.adrFiles.length > 0) {
    sections.push("## ADRs\n\n" + renderAdrsForPrompt(s.adrFiles));
  }
  if (s.entryPoints.length > 0) {
    sections.push("## Entry points\n\n" + renderEntryPointsForPrompt(s.entryPoints));
  }

  return sections.join("\n\n");
}
