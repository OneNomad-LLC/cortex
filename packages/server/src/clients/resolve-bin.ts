import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Resolve an npm package's bin script to an absolute path, so we can
 * spawn it as `node <script>` without relying on PATH.
 *
 * Why not just use the bin name: global `npm install -g` puts the bin
 * somewhere, but we can't assume PATH is set up correctly (especially
 * on Windows, where pnpm/npm bin dirs often aren't on the system
 * PATH). `require.resolve` uses Node's own module resolution, which
 * looks at node_modules upward from this file — always correct when
 * the package is a dep of @onenomad/przm-cortex.
 */
export interface ResolvedBin {
  /** Path to the node script that implements the bin. */
  script: string;
  /** Path to `node` itself (process.execPath). */
  node: string;
}

export function resolvePackageBin(
  packageName: string,
  binName?: string,
): ResolvedBin | undefined {
  const requireFromHere = createRequire(import.meta.url);
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
  const pkgDir = path.dirname(packageJsonPath);
  let pkg: { bin?: string | Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return undefined;
  }

  let binRelative: string | undefined;
  if (typeof pkg.bin === "string") {
    binRelative = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    const key = binName ?? packageName.split("/").pop() ?? packageName;
    binRelative = pkg.bin[key] ?? Object.values(pkg.bin)[0];
  }
  if (!binRelative) return undefined;
  return {
    script: path.resolve(pkgDir, binRelative),
    node: process.execPath,
  };
}
