/**
 * Slugify a note title into a kebab-case filename. ASCII-fallback —
 * non-ASCII chars are stripped because the obsidian adapter walks the
 * vault by filename, and exotic Unicode in paths breaks Windows tools
 * + makes URL routing in the dashboard a future hazard.
 *
 * Empty input → "untitled" so we always produce a valid filename.
 */
export function slugify(title: string): string {
  const ascii = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .replace(/[^a-zA-Z0-9\s-]/g, "")  // ASCII alphanumeric + space + hyphen only
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii : "untitled";
}

/**
 * Pick the next non-colliding slug given an `exists(slug)` predicate.
 * Tries `<base>` first, then `<base>-2`, `<base>-3`, … to a sane cap.
 * Caller-provided existence check keeps this pure — production wires
 * filesystem stat, tests wire a Set.
 */
export function pickAvailableSlug(
  base: string,
  exists: (candidate: string) => boolean,
  maxAttempts: number = 999,
): string {
  if (!exists(base)) return base;
  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  // Truly absurd input — fall back to a high-entropy suffix so we
  // don't lock the dashboard into spinning forever on collision.
  return `${base}-${Date.now()}`;
}
