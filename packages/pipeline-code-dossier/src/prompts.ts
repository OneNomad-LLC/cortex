import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * Prompts live as sibling .md files. Build copies them into dist/prompts/
 * so the shipped package finds them at the same relative location.
 */
const PROMPTS_DIR = path.join(here, "prompts");

const cache = new Map<string, string>();

export async function loadPrompt(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = await readFile(path.join(PROMPTS_DIR, name), "utf8");
  cache.set(name, text);
  return text;
}

/** Replace `{{NAME}}` tokens in a prompt with values from `vars`. */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : value;
  });
}
