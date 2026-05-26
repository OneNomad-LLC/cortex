/**
 * Static-asset route for the dashboard SPA.
 *
 *   GET /_dashboard            → index.html (SPA shell)
 *   GET /_dashboard/           → index.html
 *   GET /_dashboard/<path>     → file from packages/dashboard/dist or
 *                                SPA fallback to index.html when the
 *                                path is a virtual (client-side) route
 *
 * Registered BEFORE the auth gate in `server.ts` so the login UI can
 * load for unauthenticated users — anything the dashboard fetches over
 * `/api/*` enforces auth on its own. This file never executes user
 * code or evaluates JSON; it only streams bytes off disk inside a
 * path-prefix sandbox.
 *
 * Path-traversal defense: we normalize the URL-decoded tail with
 * `path.normalize` and verify that the resolved absolute path still
 * lives under the dashboard `dist/` directory. Anything that tries to
 * escape via `..` or absolute-looking segments gets rejected with 400.
 *
 * Caching:
 *   /_dashboard/assets/*   → public, max-age=31536000, immutable
 *                            (filenames are content-hashed by Vite)
 *   index.html             → no-cache, must-revalidate
 *                            (the entry point pulls in the latest
 *                             hashed assets after a deploy)
 */

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "../route-context.js";
import { findRepoRoot } from "../../cli/dotenv.js";

/**
 * Resolve where `@onenomad/przm-cortex-dashboard`'s built `dist/` lives.
 * Two layouts ship in the wild:
 *
 *   1. Monorepo checkout — `<repo>/packages/dashboard/dist/`. The
 *      installer's `pnpm -r build` writes here; `findRepoRoot()` walks
 *      up looking for the workspace marker.
 *
 *   2. npm-global install — the dashboard ships as a sibling package
 *      next to the server inside `node_modules/@onenomad/`. There's no
 *      workspace marker upstairs; `require.resolve` is the canonical
 *      way to ask Node where the package lives.
 *
 * Cached after the first successful lookup so we don't re-resolve on
 * every request.
 */
let cachedDistDir: string | undefined;
function resolveDistDir(): string {
  if (cachedDistDir) return cachedDistDir;

  // Try the monorepo path first — fast, no module-resolution traversal.
  const monorepoDist = path.join(
    findRepoRoot(process.cwd()),
    "packages",
    "dashboard",
    "dist",
  );
  if (existsSync(path.join(monorepoDist, "index.html"))) {
    cachedDistDir = monorepoDist;
    return cachedDistDir;
  }

  // Fall back to the installed package — works for `npm install -g`
  // layouts where the dashboard lives at
  // <prefix>/lib/node_modules/@onenomad/przm-cortex-dashboard/dist/.
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@onenomad/przm-cortex-dashboard/package.json");
    cachedDistDir = path.join(path.dirname(pkgJson), "dist");
    return cachedDistDir;
  } catch {
    // No installed dashboard either; return the monorepo path so the
    // serveIndex handler can render its 503 + plain-text instructions.
    cachedDistDir = monorepoDist;
    return cachedDistDir;
  }
}

const PREFIX = "/_dashboard";

/**
 * Security headers we attach to every dashboard response. `frame-ancestors`
 * lives in CSP (sent only on index.html, see below); the `X-Frame-Options`
 * twin gives us coverage on older user-agents too.
 */
const BASE_SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

/**
 * Tightest CSP we can ship without breaking Vite's CSS-in-JS injection.
 * `style-src 'unsafe-inline'` is required because shadcn/Tailwind emit
 * inline styles for runtime theme variables. Everything else stays on
 * `'self'`. Tighten further once we drop the inline-style dependency.
 */
const INDEX_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
  "font-src 'self' data:; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'";

interface MimeEntry {
  type: string;
  /** When true, append `; charset=utf-8`. */
  text?: boolean;
}

const MIME: Record<string, MimeEntry> = {
  ".html": { type: "text/html", text: true },
  ".htm": { type: "text/html", text: true },
  ".js": { type: "application/javascript", text: true },
  ".mjs": { type: "application/javascript", text: true },
  ".css": { type: "text/css", text: true },
  ".json": { type: "application/json", text: true },
  ".map": { type: "application/json", text: true },
  ".svg": { type: "image/svg+xml", text: true },
  ".txt": { type: "text/plain", text: true },
  ".ico": { type: "image/x-icon" },
  ".png": { type: "image/png" },
  ".jpg": { type: "image/jpeg" },
  ".jpeg": { type: "image/jpeg" },
  ".gif": { type: "image/gif" },
  ".webp": { type: "image/webp" },
  ".avif": { type: "image/avif" },
  ".woff": { type: "font/woff" },
  ".woff2": { type: "font/woff2" },
  ".ttf": { type: "font/ttf" },
  ".otf": { type: "font/otf" },
  ".wasm": { type: "application/wasm" },
};

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<boolean> {
  const { pathname } = ctx;

  // `/_dashboard` (no trailing slash) and `/_dashboard/...` both belong
  // to us. Anything else falls through to the next route.
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return true;
  }

  const distDir = resolveDistDir();

  // Strip the prefix to get the asset's path relative to dist/. We
  // decode percent-escapes (so spaces and unicode filenames work) but
  // reject the request if decoding fails — that's a sign of a tampered URL.
  let tail = pathname.slice(PREFIX.length);
  if (tail.startsWith("/")) tail = tail.slice(1);
  try {
    tail = decodeURIComponent(tail);
  } catch {
    sendError(res, 400, "invalid path");
    return true;
  }

  // Treat `/_dashboard` and `/_dashboard/` as the SPA root.
  if (tail === "" || tail.endsWith("/")) {
    await serveIndex(req, res, distDir, ctx);
    return true;
  }

  // Resolve and sandbox: the normalized path must still live under
  // distDir. `path.resolve(distDir, tail)` collapses any `..` segments
  // and gives us an absolute path we can compare with `startsWith`
  // plus a trailing separator to guard against `dist-evil` siblings.
  const normalizedTail = path.normalize(tail);
  if (
    normalizedTail.startsWith("..") ||
    path.isAbsolute(normalizedTail) ||
    normalizedTail.includes("\0")
  ) {
    sendError(res, 400, "invalid path");
    return true;
  }
  const target = path.resolve(distDir, normalizedTail);
  const distRoot = path.resolve(distDir);
  if (!target.startsWith(distRoot + path.sep) && target !== distRoot) {
    sendError(res, 400, "invalid path");
    return true;
  }

  // Hit: stream the file. Miss: SPA fallback when the request looks
  // like a virtual route (no extension or trailing slash), 404 when
  // the request was clearly for a static asset that doesn't exist
  // (so failed JS/CSS fetches surface instead of silently returning HTML).
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (looksLikeSpaRoute(tail)) {
        await serveIndex(req, res, distDir, ctx);
        return true;
      }
      sendError(res, 404, "not found");
      return true;
    }
    ctx.logger.warn("api.dashboard_assets.stat_failed", {
      path: pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, "internal error");
    return true;
  }

  if (info.isDirectory()) {
    // No directory listings, ever. Fall back to the SPA if this looks
    // like a virtual route; otherwise refuse.
    if (looksLikeSpaRoute(tail)) {
      await serveIndex(req, res, distDir, ctx);
      return true;
    }
    sendError(res, 404, "not found");
    return true;
  }

  await streamFile(req, res, target, info.size, ctx);
  return true;
}

function looksLikeSpaRoute(tail: string): boolean {
  if (tail.endsWith("/")) return true;
  // No extension → almost certainly a client-side route (e.g.
  // `/_dashboard/workspaces/foo`). Files we serve have one of the
  // extensions in MIME above.
  return !path.extname(tail);
}

async function serveIndex(
  req: IncomingMessage,
  res: ServerResponse,
  distDir: string,
  ctx: RouteContext,
): Promise<void> {
  const indexPath = path.join(distDir, "index.html");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(indexPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Dist not built — return a tiny placeholder so the operator gets
      // an obvious signal instead of a generic 404. Phase 0 isn't done
      // until `pnpm --filter @onenomad/przm-cortex-dashboard build`
      // has run at least once.
      res.writeHead(503, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        ...BASE_SECURITY_HEADERS,
      });
      res.end("dashboard build missing — run pnpm --filter @onenomad/przm-cortex-dashboard build");
      return;
    }
    ctx.logger.warn("api.dashboard_assets.index_stat_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sendError(res, 500, "internal error");
    return;
  }

  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(info.size),
    "cache-control": "no-cache, must-revalidate",
    "content-security-policy": INDEX_CSP,
    ...BASE_SECURITY_HEADERS,
  };

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeFile(indexPath, res);
}

async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
  ctx: RouteContext,
): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? { type: "application/octet-stream" };
  const contentType = mime.text ? `${mime.type}; charset=utf-8` : mime.type;

  // /assets/* gets aggressive caching because Vite hashes the
  // filenames. Everything else (e.g. a copied-through favicon)
  // gets a short-ish cache. Tweak as needed.
  const isHashedAsset = filePath.includes(`${path.sep}assets${path.sep}`);
  const cacheControl = isHashedAsset
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";

  res.writeHead(200, {
    "content-type": contentType,
    "content-length": String(size),
    "cache-control": cacheControl,
    ...BASE_SECURITY_HEADERS,
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  try {
    await pipeFile(filePath, res);
  } catch (err) {
    ctx.logger.warn("api.dashboard_assets.stream_failed", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    // Headers already sent — just end the response.
    if (!res.writableEnded) res.end();
  }
}

function pipeFile(filePath: string, res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...BASE_SECURITY_HEADERS,
  });
  res.end(message);
}
