/**
 * Memory type taxonomy. Built-in canonical types cover the most common
 * enterprise categories; per-workspace `customTypes` in `cortex.yaml`
 * extend the set without code changes. The MemoryTypeRegistry merges
 * both at runtime — validators, search filters, and the dashboard all
 * consult it instead of consulting a static enum.
 *
 * Why not a Zod enum: customer-extensible. Why a registry object: the
 * auto-add path (an LLM classifier emitting a previously-unseen type)
 * needs to mutate the live set during ingestion, and Zod enums are
 * frozen at construction.
 */

/**
 * Built-in canonical types. These ship with every Cortex install and
 * cannot be removed. Adding to this list is a Cortex code change;
 * customers extend via `taxonomy.customTypes` in cortex.yaml.
 *
 * Grouping (informal, not enforced):
 *   knowledge work     — meeting, decision, action_item, doc, code,
 *                        note, brief, digest, conversation, commit,
 *                        event, reference, session_handoff
 *   ops + engineering  — ticket, incident, postmortem, runbook, spec,
 *                        rfc, pr_review
 *   legal + compliance — contract, policy
 *   customer + comms   — customer_feedback, email, transcript
 */
export const BUILT_IN_MEMORY_TYPES = [
  // Original 0.2 set
  "meeting",
  "decision",
  "action_item",
  "doc",
  "code",
  "note",
  "brief",
  "digest",
  "conversation",
  "commit",
  "event",
  "reference",
  "session_handoff",
  // Enterprise expansion (0.4)
  "ticket",
  "incident",
  "postmortem",
  "runbook",
  "spec",
  "rfc",
  "pr_review",
  "contract",
  "policy",
  "customer_feedback",
  "email",
  "transcript",
] as const;

export type BuiltInMemoryType = (typeof BUILT_IN_MEMORY_TYPES)[number];

/**
 * A custom type registered against a workspace. `source` records how it
 * got there so operators can audit drift in the dashboard's Memory
 * Types tab: `config` types were added intentionally; `auto` types came
 * from an unknown classifier output and may be typos or near-duplicates.
 */
export interface CustomMemoryType {
  slug: string;
  /** Human-readable label. Defaults to a title-cased slug. */
  label?: string | undefined;
  /** Optional explanation surfaced in the dashboard. */
  description?: string | undefined;
  /** How it was registered. `config` survives a restart only because
   *  it lives in cortex.yaml; `auto` gets persisted there too, but the
   *  origin marker lets operators clean up later. */
  source: "config" | "auto";
}

/**
 * Aggressively normalize an incoming type string so the registry never
 * grows three near-duplicates ("Ticket", "tickets", "ticket "). The
 * normalize → register pipeline is the only sanctioned write path.
 *
 * Rules:
 *   - lowercase
 *   - collapse whitespace and hyphens to underscores
 *   - strip anything that isn't [a-z0-9_]
 *   - trim leading / trailing underscores
 *   - naive plural→singular for common suffixes (s, es, ies → y)
 */
export function normalizeMemoryType(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  s = s.replace(/[\s-]+/g, "_");
  s = s.replace(/[^a-z0-9_]/g, "");
  s = s.replace(/^_+|_+$/g, "");
  s = s.replace(/__+/g, "_");
  // Plural → singular. Conservative — only the common English endings.
  // Preserves words that legitimately end in -s like "kudos" only by
  // accident; an operator can add a custom type that diverges and the
  // normalize call won't touch a re-registered form (it's idempotent).
  if (/[^aeiou]ies$/.test(s)) s = s.replace(/ies$/, "y");
  else if (/(ches|shes|xes|sses)$/.test(s)) s = s.replace(/es$/, "");
  else if (/[^s]s$/.test(s)) s = s.replace(/s$/, "");
  return s;
}

export type MemoryTypeOrigin = "built-in" | "config" | "auto";

export interface MemoryTypeInfo {
  slug: string;
  label: string;
  origin: MemoryTypeOrigin;
  description?: string;
}

/**
 * Live registry of memory types known to this Cortex instance.
 * Seeded from config at boot; the auto-add path mutates it during
 * ingestion when an unknown type arrives. Wire a `persist` callback to
 * write registrations back to cortex.yaml so they survive a restart.
 */
export class MemoryTypeRegistry {
  private readonly custom = new Map<string, CustomMemoryType>();
  private readonly persist?: (types: CustomMemoryType[]) => Promise<void>;

  constructor(opts?: {
    initialCustom?: CustomMemoryType[];
    /** Called every time the custom set changes. Async; failures are
     *  swallowed so an unwritable config doesn't block ingestion. */
    persist?: (types: CustomMemoryType[]) => Promise<void>;
  }) {
    for (const t of opts?.initialCustom ?? []) {
      const slug = normalizeMemoryType(t.slug);
      if (!slug || this.isBuiltIn(slug)) continue;
      this.custom.set(slug, { ...t, slug });
    }
    if (opts?.persist) this.persist = opts.persist;
  }

  isBuiltIn(type: string): boolean {
    return (BUILT_IN_MEMORY_TYPES as readonly string[]).includes(type);
  }

  has(type: string): boolean {
    return this.isBuiltIn(type) || this.custom.has(type);
  }

  /**
   * Register a type. Returns the normalized slug, or `undefined` when
   * the input is empty/garbage. Idempotent for already-known types.
   * Built-ins win — registering "meeting" with `source: "auto"` is a
   * no-op and returns the built-in slug.
   */
  register(
    raw: string,
    opts: { source: "config" | "auto"; label?: string; description?: string },
  ): string | undefined {
    const slug = normalizeMemoryType(raw);
    if (!slug) return undefined;
    if (this.isBuiltIn(slug)) return slug;

    const existing = this.custom.get(slug);
    if (existing) {
      // Promote auto → config when an operator explicitly adds it.
      if (existing.source === "auto" && opts.source === "config") {
        const next: CustomMemoryType = {
          ...existing,
          source: "config",
          ...(opts.label !== undefined ? { label: opts.label } : {}),
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
        };
        this.custom.set(slug, next);
        void this.flush();
      }
      return slug;
    }

    const entry: CustomMemoryType = {
      slug,
      source: opts.source,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.description !== undefined
        ? { description: opts.description }
        : {}),
    };
    this.custom.set(slug, entry);
    void this.flush();
    return slug;
  }

  /**
   * Remove a custom type. Built-ins cannot be removed and return false.
   * Existing memories stamped with the removed type aren't rewritten —
   * the slug just stops auto-completing in the dashboard and stops
   * passing `has()` checks.
   */
  remove(slug: string): boolean {
    if (this.isBuiltIn(slug)) return false;
    const removed = this.custom.delete(slug);
    if (removed) void this.flush();
    return removed;
  }

  list(): MemoryTypeInfo[] {
    const builtIn = BUILT_IN_MEMORY_TYPES.map<MemoryTypeInfo>((slug) => ({
      slug,
      label: titleCase(slug),
      origin: "built-in",
    }));
    const custom = Array.from(this.custom.values()).map<MemoryTypeInfo>(
      (t) => ({
        slug: t.slug,
        label: t.label ?? titleCase(t.slug),
        origin: t.source,
        ...(t.description !== undefined
          ? { description: t.description }
          : {}),
      }),
    );
    return [...builtIn, ...custom];
  }

  customTypes(): CustomMemoryType[] {
    return Array.from(this.custom.values());
  }

  private flush(): Promise<void> {
    if (!this.persist) return Promise.resolve();
    return this.persist(this.customTypes()).catch(() => undefined);
  }
}

function titleCase(slug: string): string {
  return slug
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
