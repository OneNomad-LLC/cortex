import { z } from "zod";

/**
 * Slug format: kebab-case, letters/numbers/hyphens only. Used as the
 * canonical id in memory metadata and everywhere else.
 */
const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be kebab-case (a-z, 0-9, -)");

export const projectSourcesSchema = z
  .object({
    /** Confluence space key (e.g. "ALPHA"). */
    confluence_space: z.string().optional(),
    /** Jira project key (e.g. "ALPHA"). */
    jira_project_key: z.string().optional(),
    /** Bitbucket repo slugs that belong to this project. */
    bitbucket_repos: z.array(z.string()).optional(),
    /** GitHub repo slugs ("owner/repo") that belong to this project. */
    github_repos: z.array(z.string()).optional(),
    /** Google Calendar id that covers this project's meetings. */
    google_calendar_id: z.string().optional(),
    /** Loom folder/workspace id, if content is scoped per-project. */
    loom_folder: z.string().optional(),
    /** Obsidian path prefix that maps to this project. */
    obsidian_path: z.string().optional(),
    /** Slack channel ids. */
    slack_channels: z.array(z.string()).optional(),
  })
  .passthrough(); // accept future source-specific keys

export const projectSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  /**
   * Whether the project is currently worked on. Inactive projects stay in
   * the taxonomy so historical memories still resolve, but they're
   * de-prioritized in tools like `list_projects`.
   */
  active: z.boolean().default(true),
  /**
   * Alternate names/acronyms found in meetings and docs. Used for
   * classification and `get_project_context` lookup.
   */
  aliases: z.array(z.string().min(1)).default([]),
  /** Person slugs (defined in people.yaml). */
  people: z.array(slugSchema).default([]),
  sources: projectSourcesSchema.default({}),
});

export type Project = z.infer<typeof projectSchema>;

/**
 * Top-level shape of config/projects.yaml.
 */
export const projectsFileSchema = z.object({
  projects: z.array(projectSchema).default([]),
});

export type ProjectsFile = z.infer<typeof projectsFileSchema>;

/**
 * Normalize a string for alias matching: lower-cased, punctuation stripped,
 * whitespace collapsed. Used both when loading aliases and when resolving
 * a user-entered name.
 */
export function normalizeAlias(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
