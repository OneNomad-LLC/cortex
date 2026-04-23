import { input, password, confirm, select, checkbox } from "@inquirer/prompts";
import type {
  DerivedTaxonomy,
  WizardModule,
  WizardResult,
  WizardSecret,
  WizardStep,
} from "@onenomad/cortex-core";

/**
 * CLI runner for a WizardModule spec. Imports from @onenomad/cortex-core are
 * framework-agnostic; all inquirer calls are scoped to this file. The
 * runner is used by `cortex init`, `cortex add`, and `cortex configure`;
 * a React form renderer in the dashboard will consume the same spec
 * via a different runner without touching the module's wizard code.
 */

export interface RunWizardOptions {
  /** Pre-filled values used as step defaults — for `cortex configure`. */
  currentValues?: Record<string, unknown>;
  /** Pre-filled secrets (from existing .env) so the user can accept as-is. */
  currentSecrets?: Record<string, string>;
}

/**
 * Walk a wizard spec, collect answers, validate against the module's Zod
 * schema, and return the result. Throws if the user aborts (ctrl-c) or if
 * validation keeps failing — calling code should catch and surface a
 * short error.
 */
export async function runWizard<TConfig>(
  module: WizardModule<TConfig>,
  opts: RunWizardOptions = {},
): Promise<WizardResult<TConfig>> {
  process.stdout.write(`\n=== ${module.name} ===\n`);
  if (module.description) {
    process.stdout.write(`${module.description}\n\n`);
  }

  const state: Record<string, unknown> = { ...(opts.currentValues ?? {}) };
  for (const step of module.steps) {
    // Steps with an empty prompt are schema-placeholder shims (e.g.
    // Confluence's spaceToProject, which exists only to satisfy the
    // Zod schema while the real mapping lives in a richer step).
    // Skip the prompt but still seed the default so the config parses.
    if (step.prompt.trim().length === 0) {
      if (state[step.key] === undefined && step.defaultValue !== undefined) {
        state[step.key] = step.defaultValue;
      }
      continue;
    }
    state[step.key] = await askStep(step, state);
  }

  const secrets: Record<string, string> = {};
  if (module.secrets) {
    for (const spec of module.secrets) {
      secrets[spec.envVar] = await askSecret(spec, opts.currentSecrets?.[spec.envVar]);
    }
  }

  const parsed = module.configSchema.safeParse(state);
  if (!parsed.success) {
    process.stderr.write(
      `\nConfig validation failed:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}\n`,
    );
    throw new Error(`wizard: ${module.id} config failed validation`);
  }

  const derivedTaxonomy = module.derivedTaxonomy?.(state);

  return {
    moduleId: module.id,
    category: module.category,
    config: parsed.data,
    secrets,
    ...(derivedTaxonomy ? { derivedTaxonomy: pruneEmpty(derivedTaxonomy) } : {}),
  };
}

async function askStep(step: WizardStep, state: Record<string, unknown>): Promise<unknown> {
  const base = {
    message: step.prompt,
  };
  const current = state[step.key];

  switch (step.type) {
    case "text": {
      const value = await input({
        ...base,
        ...(current !== undefined ? { default: String(current) } : step.defaultValue !== undefined ? { default: String(step.defaultValue) } : {}),
        validate: (v: string) => {
          if (step.required && v.trim().length === 0) return "required";
          if (step.pattern && v.length > 0 && !step.pattern.test(v)) {
            return step.patternHint ?? `must match ${step.pattern}`;
          }
          return true;
        },
      });
      return value.trim();
    }
    case "password": {
      return password({ ...base, mask: "*" });
    }
    case "boolean": {
      return confirm({
        ...base,
        default: current === undefined ? (step.defaultValue as boolean ?? false) : Boolean(current),
      });
    }
    case "select": {
      return select({
        ...base,
        choices: step.choices.map((c) => ({
          value: c.value,
          name: c.label,
          ...(c.description ? { description: c.description } : {}),
        })),
        ...(current !== undefined ? { default: String(current) } : step.defaultValue !== undefined ? { default: String(step.defaultValue) } : {}),
      });
    }
    case "list": {
      const raw = await input({
        ...base,
        ...(Array.isArray(current) ? { default: current.join(", ") } : {}),
        validate: (v: string) => {
          if (step.required && v.trim().length === 0) return "required";
          return true;
        },
      });
      const splitter = step.splitter ?? /[\s,]+/;
      const items = raw
        .split(splitter)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (step.itemPattern) {
        for (const item of items) {
          if (!step.itemPattern.test(item)) {
            process.stderr.write(`  invalid entry skipped: ${item}\n`);
          }
        }
      }
      return items;
    }
    case "repeat-per": {
      const sourceVal = state[step.source];
      if (!Array.isArray(sourceVal)) {
        throw new Error(
          `wizard: repeat-per step "${step.key}" references "${step.source}" which is not an array`,
        );
      }
      const out: Record<string, Record<string, unknown>> = {};
      for (const entry of sourceVal as string[]) {
        process.stdout.write(`\n  --- For "${entry}" ---\n`);
        const sub: Record<string, unknown> = {};
        for (const subStep of step.sub) {
          sub[subStep.key] = await askStep(subStep, sub);
        }
        out[entry] = sub;
      }
      return out;
    }
    case "record": {
      const out: Record<string, string> = {};
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const key = await input({
          message: step.keyPrompt,
          validate: (v: string) => (v.trim().length === 0 && step.required ? "required" : true),
        });
        if (!key.trim()) break;
        const value = await input({ message: step.valuePrompt });
        out[key.trim()] = value.trim();
        const more = await confirm({ message: "Add another?", default: false });
        if (!more) break;
      }
      return out;
    }
    default: {
      const exhaust: never = step;
      void exhaust;
      throw new Error(`wizard: unknown step type`);
    }
  }
}

async function askSecret(spec: WizardSecret, current?: string): Promise<string> {
  const prompt = current
    ? `${spec.prompt} (press Enter to keep existing)`
    : spec.prompt;
  const ask = spec.type === "password" ? password : input;
  const value = await ask({
    message: prompt,
    ...(spec.type === "password" ? { mask: "*" } : {}),
  });
  if (!value && current) return current;
  if (!value && spec.required !== false) {
    throw new Error(`wizard: ${spec.envVar} is required`);
  }
  return value;
}

function pruneEmpty(t: DerivedTaxonomy): DerivedTaxonomy {
  const out: DerivedTaxonomy = {};
  if (t.projects && t.projects.length > 0) out.projects = t.projects;
  if (t.people && t.people.length > 0) out.people = t.people;
  if (t.engagements && t.engagements.length > 0) out.engagements = t.engagements;
  return out;
}

// Re-export for convenience — the select/checkbox primitives are useful
// to callers wrapping the runner (e.g., `cortex add` choosing between
// modules before handing off to runWizard).
export { select, checkbox };
