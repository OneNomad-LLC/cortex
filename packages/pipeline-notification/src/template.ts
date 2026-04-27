import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tiny mustache-ish template renderer. Supports:
 *   - `{{var}}` → variable interpolation
 *   - `{{#if cond}}...{{/if}}` → conditional blocks. Truthy if `vars[cond]`
 *     is non-zero number, non-empty string, or non-empty array.
 *   - `{{else}}` → else branch inside an if
 *
 * No nested ifs, no loops, no escaping — Slack messages don't need them
 * and the prompts-as-files convention prefers a small surface that
 * renders deterministically. The upstream pipeline owns the
 * pre-formatted strings (e.g. `meeting_list` is one already-formatted
 * block) so the template just stitches.
 */

export type TemplateVars = Record<string, unknown>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "prompts");

export type TemplateName =
  | "morning-brief"
  | "pre-meeting-brief"
  | "eod-capture";

export function loadTemplate(name: TemplateName): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf-8");
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  // Process if/else blocks first so nested {{var}} inside the chosen
  // branch still gets interpolated by the second pass.
  const ifProcessed = renderIfBlocks(template, vars);
  return renderInterpolation(ifProcessed, vars);
}

const IF_PATTERN = /\{\{#if\s+(\w+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;

function renderIfBlocks(template: string, vars: TemplateVars): string {
  return template.replace(IF_PATTERN, (_match, varName: string, ifBranch: string, elseBranch?: string) => {
    return isTruthy(vars[varName]) ? ifBranch : (elseBranch ?? "");
  });
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

const VAR_PATTERN = /\{\{(\w+)\}\}/g;

function renderInterpolation(template: string, vars: TemplateVars): string {
  return template.replace(VAR_PATTERN, (_match, varName: string) => {
    const v = vars[varName];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

export function render(name: TemplateName, vars: TemplateVars): string {
  return renderTemplate(loadTemplate(name), vars);
}
