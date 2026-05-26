import { createHash } from "node:crypto";
import {
  buildStructuralPayload,
} from "./structural.js";
import type {
  AdrFile,
  CodeDossierInput,
  CodeDossierPipelineOptions,
  EntryPointFile,
  ManifestFile,
  StructuralPayload,
} from "./types.js";

/**
 * Stable SHA-256 over the structural payload Pass 1 would produce. Used
 * by callers (Slice B: `ingest_repo`) to decide whether to re-run the
 * (expensive) synthesis pass — if the SHA matches the last run's, the
 * caller skips synthesis and reuses prior memories.
 *
 * Deterministic in: file paths (sorted), file content hashes, manifest
 * payload, ADR ordering. NOT sensitive to: the repo's clone path, the
 * options object (we hash structural state, not the caller's tuning).
 *
 * Why hash CONTENT not mtime: an `ingest_repo` re-run after a `git pull`
 * lands new file mtimes whether or not the file actually changed; hashing
 * content avoids spurious re-derivation.
 */
export async function computeInputsSha(
  input: CodeDossierInput,
  opts: CodeDossierPipelineOptions = {},
): Promise<string> {
  const payload = await buildStructuralPayload(input, opts);
  return shaOfStructural(payload);
}

/**
 * Lower-level helper exposed for callers that already have a structural
 * payload in hand (e.g. inside the pipeline orchestrator). Avoids
 * double-walking the file system.
 */
export function shaOfStructural(payload: StructuralPayload): string {
  const hash = createHash("sha256");
  // The content is hashed under stable field names so a future field
  // addition can't accidentally invalidate every existing SHA. Order
  // matters; do not reshuffle.
  hash.update("v1\n");
  hash.update(`repoName:${payload.repoName}\n`);
  hash.update(`readme:${digest(payload.readme)}\n`);
  hash.update(`architecture:${digest(payload.architecture)}\n`);
  hash.update(`claudeMd:${digest(payload.claudeMd)}\n`);
  hash.update(`agentsMd:${digest(payload.agentsMd)}\n`);
  hash.update(`decisions:${digest(payload.decisions)}\n`);
  hash.update(`roadmap:${digest(payload.roadmap)}\n`);
  hash.update(`migration:${digest(payload.migration)}\n`);
  hash.update(`changelog:${digest(payload.changelog)}\n`);
  hash.update(`manifest:${manifestDigest(payload.manifest)}\n`);
  hash.update(`monorepoManifest:${manifestDigest(payload.monorepoManifest)}\n`);
  hash.update("adrFiles:\n");
  for (const adr of sortAdrs(payload.adrFiles)) {
    hash.update(`  ${adr.path}=${digest(adr.content)}\n`);
  }
  hash.update("entryPoints:\n");
  for (const ep of sortEntryPoints(payload.entryPoints)) {
    hash.update(`  ${ep.path}=${digest(ep.content)}\n`);
  }
  return hash.digest("hex");
}

function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function manifestDigest(m: ManifestFile | null): string {
  if (!m) return "absent";
  return `${m.filename}:${digest(m.content)}`;
}

function sortAdrs(adrs: ReadonlyArray<AdrFile>): AdrFile[] {
  return [...adrs].sort((a, b) => a.path.localeCompare(b.path));
}

function sortEntryPoints(eps: ReadonlyArray<EntryPointFile>): EntryPointFile[] {
  return [...eps].sort((a, b) => a.path.localeCompare(b.path));
}
