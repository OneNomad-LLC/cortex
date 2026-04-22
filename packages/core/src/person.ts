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
});

export type Person = z.infer<typeof personSchema>;

/**
 * Top-level shape of config/people.yaml.
 */
export const peopleFileSchema = z.object({
  people: z.array(personSchema).default([]),
});

export type PeopleFile = z.infer<typeof peopleFileSchema>;
