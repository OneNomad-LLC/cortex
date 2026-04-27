import { invokeMcpTool } from "@/lib/api";

/**
 * Notes-specific alias around the shared MCP invoker. Keeping the
 * thin wrapper means call sites here read like domain code; the
 * underlying transport lives in @/lib/api so settings/search/etc.
 * share the same implementation.
 */
export async function invokeNoteTool<T>(
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  return invokeMcpTool<T>(name, input);
}

export interface NoteSummary {
  id: string;
  slug?: string;
  title: string;
  project?: string;
  tags?: string[];
  updated: string;
  preview: string;
  kind: "cortex" | "obsidian";
  relativePath?: string;
}

export interface NoteRead {
  id: string;
  kind: "cortex" | "obsidian";
  title: string;
  body: string;
  project?: string;
  tags?: string[];
  updated: string;
  relativePath: string;
}

export interface MetadataSuggestion {
  title: string;
  tags: string[];
  project?: string;
  llm: boolean;
}

export interface ProjectRow {
  slug: string;
  name: string;
  description: string;
  active: boolean;
  aliases: string[];
  people: string[];
}

export interface ListProjectsResponse {
  projects: ProjectRow[];
}
