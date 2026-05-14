import { z } from "zod";

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

export const personSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1),
  email: z.string().email(),
  /** Project slugs (defined in projects.yaml). */
  projects: z.array(slugSchema).default([]),
  /** Free-form role label — "Engineering", "Product", "Design", etc. */
  role: z.string().optional(),
  /** Alternate names/handles found in meeting attendee lists. */
  aliases: z.array(z.string().min(1)).default([]),
  /**
   * Marks this person as the user running Cortex. Exactly one person
   * should carry `self: true`. Used by retrieval tools to resolve
   * "me" references and by the urgency extractor to flag mentions
   * of the user. Optional so the field is ergonomic to add later via
   * the update_user_identity MCP tool.
   */
  self: z.boolean().optional(),
  /** Free-form team label — "Platform", "Delivery", "Design". */
  team: z.string().optional(),
  /** IANA zone id, e.g. "America/New_York". Drives due-date resolution. */
  timezone: z.string().optional(),
  /**
   * Free-form working hours hint — "9am-5pm EST" or "async". Used
   * by the digest and urgency ranker to avoid flagging tomorrow-due
   * items late in the user's day.
   */
  workHours: z.string().optional(),
});

export type Person = z.infer<typeof personSchema>;

/**
 * Top-level shape of config/people.yaml.
 */
export const peopleFileSchema = z.object({
  people: z.array(personSchema).default([]),
});

export type PeopleFile = z.infer<typeof peopleFileSchema>;
