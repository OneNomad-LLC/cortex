import { createHash } from "node:crypto";
import type { SourceType } from "@onenomad/cortex-core";

/**
 * Compose a stable source_id from a source type and one or more identifier
 * parts. Produces `<source>:<parts-joined>` when parts are short, otherwise
 * `<source>:sha256:<hex>` to keep ids indexable.
 *
 * Adapters should prefer real external ids (Loom recording id, Confluence
 * page id, etc.). This helper is for filesystem-style sources (Obsidian,
 * local files) where the best id is a path + content hash.
 */
export function computeSourceId(
  source: SourceType,
  parts: readonly (string | number)[],
): string {
  const joined = parts.map(String).join("::");
  if (joined.length <= 120 && !/[\n\r]/.test(joined)) {
    return `${source}:${joined}`;
  }
  const hash = createHash("sha256").update(joined).digest("hex").slice(0, 40);
  return `${source}:sha256:${hash}`;
}

/**
 * Hash content for change detection. Use `{ source_id, content_hash }` as the
 * real uniqueness tuple so content edits produce updates rather than dupes.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
