import type { WizardModule } from "@cortex/core";
import { confluenceWizard } from "@cortex/adapter-confluence";
import { jiraWizard } from "@cortex/adapter-jira";

/**
 * Static registry of wizard specs known to the CLI.
 *
 * Each adapter / provider / toolkit that wants guided setup exports a
 * `WizardModule` spec; we list them here explicitly (same ADR-009 pattern
 * as the adapter + provider registries). Listing here is the single place
 * new modules land when their wizards ship.
 */
const WIZARDS: WizardModule[] = [confluenceWizard, jiraWizard];

const BY_ID = new Map<string, WizardModule>();
for (const w of WIZARDS) BY_ID.set(w.id, w);

export function listWizards(): readonly WizardModule[] {
  return WIZARDS;
}

export function findWizard(id: string): WizardModule | undefined {
  return BY_ID.get(id);
}

/**
 * Group wizards by category for catalog UIs. Returns a stable ordering —
 * adapters first, then providers, memory backends, webhooks, toolkits.
 */
export function wizardsByCategory(): ReadonlyMap<
  WizardModule["category"],
  readonly WizardModule[]
> {
  const buckets = new Map<WizardModule["category"], WizardModule[]>();
  for (const w of WIZARDS) {
    const arr = buckets.get(w.category) ?? [];
    arr.push(w);
    buckets.set(w.category, arr);
  }
  return buckets;
}
