import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Locate the cortex repo's `docs/` directory at request time. Tries the
 * locations Next.js uses across deployments:
 *
 *   1. `<repo-root>/docs/` — local dev when running `pnpm dev` from the
 *      dashboard package; cwd is the package, so docs are two levels up.
 *   2. `/app/docs/` — Docker standalone runtime; outputFileTracingIncludes
 *      copies the docs into `/app/docs/` next to `packages/dashboard/`.
 *
 * Returns the first directory that exists.
 */
export async function findDocsDir(): Promise<string | undefined> {
  const candidates = [
    path.resolve(process.cwd(), "../../docs"),
    path.resolve(process.cwd(), "docs"),
  ];
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      // continue
    }
  }
  return undefined;
}

export interface DocEntry {
  slug: string;
  title: string;
  description?: string;
}

/**
 * Curated list of doc files to surface in the dashboard. Order matters —
 * this is the sidebar order. Files not in this list still render at
 * `/docs/<slug>` if the file exists, but they won't appear in the index.
 */
export const DOC_INDEX: DocEntry[] = [
  {
    slug: "MCP-STACK",
    title: "MCP stack",
    description: "How Cortex, Engram, Persona, and Synapse fit together.",
  },
  {
    slug: "USING",
    title: "Using Cortex day-to-day",
    description: "Day-in-the-life walkthrough.",
  },
  {
    slug: "SETUP",
    title: "Setup",
    description: "From-scratch installation and configuration.",
  },
  {
    slug: "ARCHITECTURE",
    title: "Architecture",
    description: "Internal data plane, pipelines, adapter contract.",
  },
  {
    slug: "DECISIONS",
    title: "Decisions (ADR log)",
    description: "Architectural decision records.",
  },
  {
    slug: "DEPLOY",
    title: "Deploy",
    description: "Operational notes for hosting Cortex.",
  },
  {
    slug: "HOSTING",
    title: "Hosting",
    description: "Recommended host topologies.",
  },
  {
    slug: "PRIVACY",
    title: "Privacy",
    description: "PII hygiene rules + the identifier scanner.",
  },
  {
    slug: "ROADMAP",
    title: "Roadmap",
    description: "Build order and current state.",
  },
];

export async function readDoc(slug: string): Promise<string | undefined> {
  const dir = await findDocsDir();
  if (!dir) return undefined;
  // Restrict to alphanumeric / dash / dot to prevent traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return undefined;
  try {
    const buf = await fs.readFile(path.join(dir, `${slug}.md`), "utf8");
    return buf;
  } catch {
    return undefined;
  }
}

export interface WorkspaceDocSummary {
  slug: string;
  title: string;
  description?: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface WorkspaceDocsList {
  workspace: string | null;
  path: string | null;
  exists: boolean;
  docs: WorkspaceDocSummary[];
}

export interface WorkspaceDocRead {
  workspace: string;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  path: string;
}
