/**
 * Metadata contract conformance test.
 *
 * Purpose: verify that the Zod runtime schema (packages/core/src/metadata.ts)
 * and the authoritative JSON Schema (schemas/memory-metadata.json) agree on
 * the structural invariants that matter for retrieval quality:
 *   - the required-field set
 *   - enum values for `sensitivity` and `trust`
 *
 * Note on `type`: the JSON Schema uses an open pattern (`^[a-z0-9_]+$`) and
 * the Zod schema uses `z.string().min(1)` — both are intentionally open since
 * 0.4 (MemoryTypeRegistry). No enum cross-check is needed for `type`.
 *
 * Note on the runtime ingest-time guard: a parse-at-ingest-boundary call
 * lives in packages/server and packages/memory-pgvector (off-limits for this
 * task). Adding it there is a recommended follow-up.
 *
 * Both schemas were reconciled 2026-05-27: `project` removed from the JSON
 * Schema `required` array (Zod made it optional in Phase 1D), and `due_date`,
 * `urgency`, `mentions_me`, `owner` added to the JSON Schema properties block.
 * The two cross-checks below now run (previously .skip'd while drift existed).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryMetadataSchema } from "../src/metadata.js";

// ---------------------------------------------------------------------------
// Load the JSON Schema from the repo root at runtime.
// This file resolves packages/core/tests/ -> repo root via ../../
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const jsonSchemaPath = path.join(repoRoot, "schemas", "memory-metadata.json");

interface JsonSchema {
  required?: string[];
  properties?: Record<
    string,
    {
      type?: string;
      enum?: string[];
      const?: string;
    }
  >;
}

const jsonSchema: JsonSchema = JSON.parse(
  readFileSync(jsonSchemaPath, "utf8"),
) as JsonSchema;

// ---------------------------------------------------------------------------
// Helper: extract enum values from the Zod schema shape.
// We only call this for fields that are genuinely z.enum() / z.literal().
// ---------------------------------------------------------------------------
function zodEnumValues(fieldName: keyof typeof memoryMetadataSchema.shape): string[] {
  // Unwrap optional wrapper if present
  let inner: any = memoryMetadataSchema.shape[fieldName];
  if (inner?._def?.typeName === "ZodOptional") {
    inner = inner._def.innerType;
  }
  if (inner?._def?.typeName === "ZodEnum") {
    return inner._def.values as string[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helper: compute the set of required (non-optional) fields from the Zod
// schema by inspecting each field's def.
// ---------------------------------------------------------------------------
function zodRequiredFields(): Set<string> {
  const required = new Set<string>();
  for (const [key, field] of Object.entries(memoryMetadataSchema.shape)) {
    const typeName = (field as any)?._def?.typeName as string | undefined;
    if (typeName !== "ZodOptional") {
      required.add(key);
    }
  }
  return required;
}

// ---------------------------------------------------------------------------
// Suite 1: Cross-schema structural agreement
// ---------------------------------------------------------------------------
describe("metadata contract — cross-schema agreement", () => {
  it("JSON Schema file is loadable and has required/properties", () => {
    expect(jsonSchema).toBeDefined();
    expect(Array.isArray(jsonSchema.required)).toBe(true);
    expect(typeof jsonSchema.properties).toBe("object");
  });

  // -----------------------------------------------------------------------
  // Required-field agreement.
  //
  // KNOWN DRIFT: `project` is in JSON Schema required but optional in Zod
  // (Phase 1D intentional change). The test below skips rather than
  // failing hard so CI stays green while the drift is documented. Fix by
  // either updating the JSON Schema to remove `project` from `required`
  // (preferred) or reverting the Zod optional — see the 2026-05-09 note.
  //
  // KNOWN DRIFT: `due_date`, `urgency`, `mentions_me`, `owner` are present
  // in the Zod schema but absent from the JSON Schema `properties`. The
  // test below uses .skip for the symmetric check so it is visible but
  // doesn't block.
  // -----------------------------------------------------------------------
  it("Zod required fields are a subset of JSON Schema required fields (excluding documented drift)", () => {
    const jsonRequired = new Set(jsonSchema.required ?? []);
    const zodRequired = zodRequiredFields();

    // Fields required by Zod that the JSON Schema also requires (no drift here).
    // We exclude `project` from Zod's required set because Zod intentionally
    // made it optional in Phase 1D; we don't want to re-introduce a false
    // alarm every run.
    for (const field of zodRequired) {
      expect(
        jsonRequired.has(field),
        `Zod requires "${field}" but JSON Schema does not list it as required`,
      ).toBe(true);
    }
  });

  it(
    // Reconciled 2026-05-27: `project` removed from the JSON Schema `required`
    // array to match Zod (optional since Phase 1D, 2026-05-09).
    "JSON Schema required fields match Zod required fields exactly",
    () => {
      const jsonRequired = new Set(jsonSchema.required ?? []);
      const zodRequired = zodRequiredFields();

      const onlyInJson = [...jsonRequired].filter((f) => !zodRequired.has(f));
      const onlyInZod = [...zodRequired].filter((f) => !jsonRequired.has(f));

      expect(onlyInJson, "Fields in JSON required but not Zod required").toEqual([]);
      expect(onlyInZod, "Fields in Zod required but not JSON required").toEqual([]);
    },
  );

  it(
    // Reconciled 2026-05-27: due_date, urgency, mentions_me, owner added to
    // the JSON Schema properties block to match the Zod schema.
    "Zod shape fields are all present in JSON Schema properties",
    () => {
      const jsonProps = new Set(Object.keys(jsonSchema.properties ?? {}));
      const zodFields = Object.keys(memoryMetadataSchema.shape);

      const missingFromJson = zodFields.filter((f) => !jsonProps.has(f));
      expect(
        missingFromJson,
        "Zod fields missing from JSON Schema properties",
      ).toEqual([]);
    },
  );

  it("sensitivity enum values agree between Zod and JSON Schema", () => {
    const jsonEnums = jsonSchema.properties?.["sensitivity"]?.enum ?? [];
    const zodEnums = zodEnumValues("sensitivity");

    expect(zodEnums.sort()).toEqual(jsonEnums.sort());
  });

  it("trust enum values agree between Zod and JSON Schema", () => {
    const jsonEnums = jsonSchema.properties?.["trust"]?.enum ?? [];
    const zodEnums = zodEnumValues("trust");

    expect(zodEnums.sort()).toEqual(jsonEnums.sort());
  });

  it("source enum values agree between Zod and JSON Schema", () => {
    const jsonEnums = jsonSchema.properties?.["source"]?.enum ?? [];
    const zodEnums = zodEnumValues("source");

    expect(zodEnums.sort()).toEqual(jsonEnums.sort());
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Zod schema round-trip — valid objects parse, invalid objects fail
// ---------------------------------------------------------------------------

const VALID_BASE = {
  domain: "work" as const,
  source: "loom" as const,
  source_id: "loom-abc-123",
  source_url: "https://www.loom.com/share/abc123",
  type: "meeting",
  people: ["alice", "bob"],
  date: "2026-05-27T09:00:00Z",
  confidence: 0.9,
} as const;

describe("metadata contract — Zod round-trip (valid objects)", () => {
  it("parses a minimal valid metadata object (no optional fields)", () => {
    const result = memoryMetadataSchema.safeParse(VALID_BASE);
    expect(result.success).toBe(true);
  });

  it("parses a fully-populated valid metadata object", () => {
    const full = {
      ...VALID_BASE,
      project: "onenomad",
      title: "Sprint retrospective",
      parent_id: "parent-001",
      tags: ["q2", "retrospective"],
      trace_id: "trace-xyz",
      sensitivity: "internal",
      trust: "approved",
      status: "approved",
      engagement: "driven-brands",
      sub_brand: "jiffy-lube",
      release: "v2.3",
      team: "platform",
      workspace: "work",
      due_date: "2026-06-01T00:00:00Z",
      urgency: "high",
      mentions_me: true,
      owner: "alice",
    };
    const result = memoryMetadataSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("parses without the project field (Phase 1D: project is optional)", () => {
    const withoutProject = { ...VALID_BASE };
    const result = memoryMetadataSchema.safeParse(withoutProject);
    expect(result.success).toBe(true);
  });

  it("parses with project as an array of slugs", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      project: ["project-a", "project-b"],
    });
    expect(result.success).toBe(true);
  });

  it("parses an open (non-canonical) type value (MemoryTypeRegistry is open)", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      type: "custom_workspace_type",
    });
    expect(result.success).toBe(true);
  });

  it("parses each sensitivity value", () => {
    for (const val of ["public", "internal", "confidential", "restricted"] as const) {
      const result = memoryMetadataSchema.safeParse({ ...VALID_BASE, sensitivity: val });
      expect(result.success, `sensitivity="${val}" should be valid`).toBe(true);
    }
  });

  it("parses each trust value", () => {
    for (const val of ["approved", "experimental", "external"] as const) {
      const result = memoryMetadataSchema.safeParse({ ...VALID_BASE, trust: val });
      expect(result.success, `trust="${val}" should be valid`).toBe(true);
    }
  });

  it("parses each source value", () => {
    const sources = [
      "loom", "google_meet", "confluence", "notion", "google_drive",
      "jira", "linear", "bitbucket", "github", "calendar",
      "slack", "teams", "email", "obsidian", "manual",
    ] as const;
    for (const src of sources) {
      const result = memoryMetadataSchema.safeParse({ ...VALID_BASE, source: src });
      expect(result.success, `source="${src}" should be valid`).toBe(true);
    }
  });
});

describe("metadata contract — Zod round-trip (invalid objects rejected)", () => {
  it("rejects when domain is missing", () => {
    const { domain: _d, ...withoutDomain } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutDomain);
    expect(result.success).toBe(false);
  });

  it("rejects when source is missing", () => {
    const { source: _s, ...withoutSource } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutSource);
    expect(result.success).toBe(false);
  });

  it("rejects when source_id is missing", () => {
    const { source_id: _si, ...withoutSourceId } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutSourceId);
    expect(result.success).toBe(false);
  });

  it("rejects when source_url is missing", () => {
    const { source_url: _su, ...withoutSourceUrl } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutSourceUrl);
    expect(result.success).toBe(false);
  });

  it("rejects when type is missing", () => {
    const { type: _t, ...withoutType } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutType);
    expect(result.success).toBe(false);
  });

  it("rejects when people is missing", () => {
    const { people: _p, ...withoutPeople } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutPeople);
    expect(result.success).toBe(false);
  });

  it("rejects when date is missing", () => {
    const { date: _d, ...withoutDate } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutDate);
    expect(result.success).toBe(false);
  });

  it("rejects when confidence is missing", () => {
    const { confidence: _c, ...withoutConfidence } = VALID_BASE;
    const result = memoryMetadataSchema.safeParse(withoutConfidence);
    expect(result.success).toBe(false);
  });

  it("rejects an invalid sensitivity value", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      sensitivity: "top_secret",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid trust value", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      trust: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid source value", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      source: "telegram",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL source_url", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      source_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence below 0", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty source_id", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      source_id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty type", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      type: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime date string", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      date: "2026-05-27",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid urgency value", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      urgency: "critical",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    const result = memoryMetadataSchema.safeParse({
      ...VALID_BASE,
      status: "pending",
    });
    expect(result.success).toBe(false);
  });
});
