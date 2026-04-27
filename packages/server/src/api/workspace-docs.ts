import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@onenomad/cortex-core";
import {
  findWorkspace,
  getActiveWorkspace,
  type Workspace,
} from "../cli/workspace/manager.js";

/**
 * Per-workspace markdown docs surface.
 *
 *   GET /api/workspace-docs?workspace=<slug>          — list markdown
 *                                                       files in the
 *                                                       workspace's
 *                                                       docs/ dir
 *   GET /api/workspace-docs/<slug>?workspace=<slug>   — read one file
 *
 * The query-string `workspace` is optional; when absent we resolve the
 * active workspace from `~/.cortex/state.json`. Slugs are restricted to
 * `[A-Za-z0-9._-]+` so a caller can't traverse outside the docs/ dir.
 *
 * This is read-only on purpose — workspace docs are authored on disk
 * (Obsidian, your editor of choice) and surfaced through the dashboard
 * for at-a-glance reading. Editing them would duplicate the notes
 * surface and the round-trip risk that comes with it.
 */
export interface WorkspaceDocSummary {
  slug: string;
  title: string;
  description?: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface WorkspaceDocsListResponse {
  workspace: string | null;
  path: string | null;
  exists: boolean;
  docs: WorkspaceDocSummary[];
}

export interface WorkspaceDocReadResponse {
  workspace: string;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  path: string;
}

const SLUG_RE = /^[A-Za-z0-9._-]+$/;

export async function handleWorkspaceDocs(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger: Logger,
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  // ?workspace=<slug> wins over the on-disk active pointer; useful so
  // the dashboard can preview a workspace it isn't currently bound to
  // (e.g. the workspace switcher hover state).
  const url = new URL(req.url ?? "/", "http://localhost");
  const slugParam = url.searchParams.get("workspace");
  const workspace = await resolveWorkspace(slugParam);

  const match = pathname.match(/^\/api\/workspace-docs\/([^/]+)\/?$/);
  if (match) {
    if (!workspace) {
      sendJson(res, 404, { error: "no workspace bound" });
      return;
    }
    const docSlug = decodeURIComponent(match[1]!);
    if (!SLUG_RE.test(docSlug)) {
      sendJson(res, 400, { error: "invalid doc slug" });
      return;
    }
    await handleRead(res, workspace, docSlug, logger);
    return;
  }

  if (pathname === "/api/workspace-docs" || pathname === "/api/workspace-docs/") {
    await handleList(res, workspace, logger);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function resolveWorkspace(
  slugParam: string | null,
): Promise<Workspace | undefined> {
  if (slugParam) {
    return findWorkspace(slugParam);
  }
  return getActiveWorkspace();
}

async function handleList(
  res: ServerResponse,
  workspace: Workspace | undefined,
  logger: Logger,
): Promise<void> {
  if (!workspace) {
    const body: WorkspaceDocsListResponse = {
      workspace: null,
      path: null,
      exists: false,
      docs: [],
    };
    sendJson(res, 200, body);
    return;
  }

  const docsDir = path.join(workspace.path, "docs");
  let entries: string[];
  try {
    entries = await readdir(docsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Empty state — directory simply doesn't exist yet. UI surfaces
      // the path so the user knows where to drop markdown.
      const body: WorkspaceDocsListResponse = {
        workspace: workspace.slug,
        path: docsDir,
        exists: false,
        docs: [],
      };
      sendJson(res, 200, body);
      return;
    }
    logger.warn("api.workspace_docs.readdir_failed", {
      workspace: workspace.slug,
      path: docsDir,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: "could not read workspace docs dir" });
    return;
  }

  const docs: WorkspaceDocSummary[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const slug = entry.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    const abs = path.join(docsDir, entry);
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const head = await readHead(abs);
      docs.push({
        slug,
        title: head.title ?? slug,
        ...(head.description ? { description: head.description } : {}),
        updatedAt: new Date(info.mtimeMs).toISOString(),
        sizeBytes: info.size,
      });
    } catch (err) {
      logger.warn("api.workspace_docs.stat_failed", {
        workspace: workspace.slug,
        entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Most-recently-edited first so it matches what the user is likely
  // to want to look at when they pop the docs page.
  docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const body: WorkspaceDocsListResponse = {
    workspace: workspace.slug,
    path: docsDir,
    exists: true,
    docs,
  };
  sendJson(res, 200, body);
}

async function handleRead(
  res: ServerResponse,
  workspace: Workspace,
  slug: string,
  logger: Logger,
): Promise<void> {
  const docsDir = path.join(workspace.path, "docs");
  const abs = path.join(docsDir, `${slug}.md`);
  // Defense-in-depth: even though SLUG_RE rejects slashes and `..`,
  // verify the resolved path still lives under docsDir.
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(docsDir))) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  try {
    const [info, raw] = await Promise.all([stat(abs), readFile(abs, "utf8")]);
    const head = parseFrontmatterHead(raw);
    const body: WorkspaceDocReadResponse = {
      workspace: workspace.slug,
      slug,
      title: head.title ?? slug,
      body: head.body,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      path: abs,
    };
    sendJson(res, 200, body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(res, 404, { error: "doc not found" });
      return;
    }
    logger.warn("api.workspace_docs.read_failed", {
      workspace: workspace.slug,
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: "could not read doc" });
  }
}

interface DocHead {
  title?: string;
  description?: string;
  body: string;
}

/**
 * Read enough of a file to extract title + description. Three sources,
 * in priority order:
 *
 *   1. YAML frontmatter `title:` / `description:`
 *   2. The first `# heading` in the body
 *   3. Filename (the caller falls back to slug — we don't fabricate
 *      a title here)
 */
async function readHead(filePath: string): Promise<DocHead> {
  const raw = await readFile(filePath, "utf8");
  return parseFrontmatterHead(raw);
}

function parseFrontmatterHead(raw: string): DocHead {
  let body = raw;
  let title: string | undefined;
  let description: string | undefined;

  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fmRaw = raw.slice(raw.indexOf("\n") + 1, end);
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
      for (const line of fmRaw.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1]!.toLowerCase();
        const value = unquote(m[2]!);
        if (key === "title" && !title) title = value;
        if (key === "description" && !description) description = value;
      }
    }
  }

  if (!title) {
    const heading = body.match(/^\s*#\s+(.+?)\s*$/m);
    if (heading) title = heading[1];
  }

  const result: DocHead = { body };
  if (title) result.title = title;
  if (description) result.description = description;
  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
