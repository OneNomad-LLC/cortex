import { z } from "zod";

/**
 * JSON shape that pass 1 must emit and pass 2 preserves. Matches
 * prompts/pass1-structural.md.
 *
 * Runtime schema enforces non-null strings and trims empty arrays
 * coming back from the LLM — pipelines downstream map over these
 * fields and break on nulls silently.
 */
export const meetingStructuredSchema = z.object({
  summary: z.string().default(""),
  participants: z
    .array(
      z.object({
        name: z.string().min(1).default("Unknown"),
        role: z.string().nullish(),
      }),
    )
    .default([])
    // Drop participants the LLM sent without a name rather than
    // ingesting "Unknown" placeholders.
    .transform((arr) => arr.filter((p) => p.name && p.name !== "Unknown")),
  topics: z.array(z.string().min(1)).default([]),
  decisions: z
    .array(
      z.object({
        statement: z.string().min(1),
        owner: z.string().nullable().default(null),
        rationale: z.string().nullable().default(null),
      }),
    )
    .default([]),
  action_items: z
    .array(
      z.object({
        description: z.string().min(1),
        owner: z.string().nullable().default(null),
        due_hint: z.string().nullable().default(null),
        due_date: z.string().nullable().optional(),
      }),
    )
    .default([]),
  key_quotes: z
    .array(
      z.object({
        speaker: z.string().min(1),
        text: z.string().min(1),
      }),
    )
    .default([]),
  conflicts: z
    .array(
      z.object({
        new_decision: z.string().min(1),
        contradicts: z.string().min(1),
      }),
    )
    .optional(),
});

export type MeetingStructured = z.infer<typeof meetingStructuredSchema>;

export interface MeetingPipelineOptions {
  /** Max characters per transcript chunk. Keeps memories individually useful. */
  chunkSize?: number;
  /** Include the full brief as one memory. Default true. */
  includeBrief?: boolean;
  /** Include individual decisions as their own memories. Default true. */
  includeDecisionMemories?: boolean;
  /** Include individual action items as their own memories. Default true. */
  includeActionItemMemories?: boolean;
  /** Include transcript chunks as their own memories. Default true. */
  includeTranscriptChunks?: boolean;
  /** Max decisions/actions to emit as separate memories. Guards against runaway outputs. */
  maxSubMemories?: number;
  /**
   * Prior decisions to pass into pass 2 (JSON stringified). Pipelines
   * that plug in retrieval can populate this; default is `[]`.
   */
  priorDecisions?: string;
  /** People taxonomy JSON handed to pass 2. Default `[]`. */
  peopleContext?: string;
}
