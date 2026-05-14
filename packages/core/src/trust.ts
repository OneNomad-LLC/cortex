import type { SourceType } from "./types.js";

export type Sensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type Trust = "approved" | "experimental" | "external";

export interface TrustDefaults {
  sensitivity: Sensitivity;
  trust: Trust;
}

/**
 * Reasonable defaults per source type. Adapters/pipelines call this when
 * building memory metadata; users can override per-memory later.
 *
 * Philosophy:
 *   - "approved" = the source is a curated, team-owned surface. Confluence
 *     pages survive review; Jira/Linear tickets are explicit; GitHub/Bitbucket
 *     commits are trackable.
 *   - "experimental" = raw team chatter / private notes. Slack threads,
 *     Obsidian notes, research drafts.
 *   - "external" = content from outside the team's authored surface.
 *
 *   - "public" = none by default — assume nothing is safe to publish.
 *   - "internal" = default for most sources.
 *   - "confidential" = email and DMs.
 *   - "restricted" = none by default (reserved for future compliance-scoped sources).
 */
export function defaultTrustForSource(source: SourceType): TrustDefaults {
  switch (source) {
    case "email":
      return { sensitivity: "confidential", trust: "external" };
    case "slack":
    case "teams":
      return { sensitivity: "internal", trust: "experimental" };
    case "obsidian":
      return { sensitivity: "internal", trust: "experimental" };
    case "confluence":
    case "notion":
    case "google_drive":
    case "jira":
    case "linear":
    case "bitbucket":
    case "github":
    case "loom":
    case "google_meet":
    case "calendar":
      return { sensitivity: "internal", trust: "approved" };
    default:
      return { sensitivity: "internal", trust: "external" };
  }
}
