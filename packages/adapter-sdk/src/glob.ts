/**
 * Minimal glob matcher. Handles `*`, `**`, `?` — the subset that
 * include/exclude lists across adapter configs use in practice.
 *
 * Normalizes Windows path separators so adapters don't have to.
 */
export function matchesGlobs(
  path: string,
  include: readonly string[],
  exclude: readonly string[] = [],
): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (exclude.some((g) => globToRegex(g).test(normalized))) return false;
  if (include.length === 0) return true;
  return include.some((g) => globToRegex(g).test(normalized));
}

const globCache = new Map<string, RegExp>();

function globToRegex(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;

  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.+/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (
      c === "." ||
      c === "+" ||
      c === "(" ||
      c === ")" ||
      c === "|" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "[" ||
      c === "]"
    ) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  const compiled = new RegExp(re);
  globCache.set(glob, compiled);
  return compiled;
}
