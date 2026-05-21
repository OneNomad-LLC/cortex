import path from "node:path";
import type { Logger } from "@onenomad/przm-cortex-core";
import { loadTaxonomy, type LoadedTaxonomy, buildReader } from "./taxonomy.js";
import { findWorkspace } from "./cli/workspace/manager.js";

/**
 * Per-workspace taxonomy loader with an in-memory cache.
 *
 * Cortex's ToolContext carries a `taxonomy` that every tool reads
 * when resolving project slugs, people, etc. With session-scoped
 * workspaces, different Claude sessions need different taxonomies
 * in the SAME process — pre-session-scoping the whole cortex had
 * one global taxonomy loaded at boot.
 *
 * This cache loads taxonomy lazily per workspace slug on the first
 * tool call that needs it, and caches the result until a mutation
 * tool calls `invalidate(slug)`. Loads are cheap (two small YAML
 * files) but redundant loads on every tool call aren't free either
 * at Claude-Code tool-call frequency.
 *
 * Fallback: when no workspace is bound and no cache entry exists,
 * tools get an empty TaxonomyReader so they degrade gracefully —
 * project / people lookups just return undefined instead of throwing.
 */
export class TaxonomyCache {
  private readonly cache = new Map<string, LoadedTaxonomy>();
  private readonly inflight = new Map<string, Promise<LoadedTaxonomy>>();
  private readonly empty: LoadedTaxonomy;

  constructor(private readonly logger: Logger) {
    this.empty = buildReader([], []);
  }

  /**
   * Resolve the taxonomy for a given workspace slug. Loads on first
   * request, serves from cache after. Returns the empty reader when
   * the workspace doesn't exist on disk — tools keep running, the
   * logs surface the discrepancy.
   */
  async forWorkspace(slug: string): Promise<LoadedTaxonomy> {
    const hit = this.cache.get(slug);
    if (hit) return hit;

    const inflight = this.inflight.get(slug);
    if (inflight) return inflight;

    const promise = this.loadOne(slug).then(
      (result) => {
        this.cache.set(slug, result);
        this.inflight.delete(slug);
        return result;
      },
      (err) => {
        // Never let a failed load stick in `inflight` — otherwise
        // every subsequent `forWorkspace(slug)` call would await the
        // same already-rejected promise. Serve the empty reader so
        // tools degrade gracefully; the next call retries.
        this.inflight.delete(slug);
        this.logger.warn("taxonomy_cache.load_failed", {
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
        return this.empty;
      },
    );
    this.inflight.set(slug, promise);
    return promise;
  }

  /**
   * Drop a cache entry so the next access re-reads from disk. Call
   * from add_person / add_project / update_user_identity after a
   * successful write, and from any tool that edits the taxonomy
   * YAML files directly.
   */
  invalidate(slug: string): void {
    this.cache.delete(slug);
    this.inflight.delete(slug);
    this.logger.debug("taxonomy_cache.invalidated", { slug });
  }

  /** Useful for tests + a future /api/taxonomy-cache endpoint. */
  invalidateAll(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  size(): number {
    return this.cache.size;
  }

  /** Fallback reader tools get when nothing else resolves. */
  emptyReader(): LoadedTaxonomy {
    return this.empty;
  }

  private async loadOne(slug: string): Promise<LoadedTaxonomy> {
    const ws = await findWorkspace(slug);
    if (!ws) {
      this.logger.warn("taxonomy_cache.workspace_missing", { slug });
      return this.empty;
    }
    const taxonomy = await loadTaxonomy({
      projectsPath: path.join(ws.path, "config", "projects.yaml"),
      peoplePath: path.join(ws.path, "config", "people.yaml"),
    });
    this.logger.info("taxonomy_cache.loaded", {
      slug,
      projects: taxonomy.projects.length,
      people: taxonomy.people.length,
    });
    return taxonomy;
  }
}
