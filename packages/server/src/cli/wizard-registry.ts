import type { WizardModule } from "@onenomad/cortex-core";
import { bitbucketWizard } from "@onenomad/cortex-adapter-bitbucket";
import { confluenceWizard } from "@onenomad/cortex-adapter-confluence";
import { githubWizard } from "@onenomad/cortex-adapter-github";
import { jiraWizard } from "@onenomad/cortex-adapter-jira";
import { linearWizard } from "@onenomad/cortex-adapter-linear";
import { loomWizard } from "@onenomad/cortex-adapter-loom";
import { notionWizard } from "@onenomad/cortex-adapter-notion";
import { obsidianWizard } from "@onenomad/cortex-adapter-obsidian";
import { slackWizard } from "@onenomad/cortex-adapter-slack";
import { pgvectorWizard } from "@onenomad/cortex-memory-pgvector";
import { ollamaWizard } from "@onenomad/cortex-provider-ollama";
import { openrouterWizard } from "@onenomad/cortex-provider-openrouter";
import { webhooksWizard } from "./webhooks-wizard.js";

/**
 * Static registry of wizard specs known to the CLI.
 *
 * Each adapter / provider / toolkit that wants guided setup exports a
 * `WizardModule` spec; we list them here explicitly (same ADR-009 pattern
 * as the adapter + provider registries). Listing here is the single place
 * new modules land when their wizards ship.
 *
 * Knowledge-engine repositioning (2026-05-09): Gmail / Google Calendar /
 * Google Drive / Outlook adapters were removed — they're personal-flow
 * surfaces, not org knowledge sources. Cortex is now the multi-tenant
 * knowledge engine for Pyre; per-user inbox/calendar belongs in a
 * different layer. See cortex/docs/MIGRATION-knowledge-engine.md.
 */
const WIZARDS: WizardModule[] = [
  // adapters
  confluenceWizard,
  jiraWizard,
  bitbucketWizard,
  githubWizard,
  linearWizard,
  loomWizard,
  notionWizard,
  obsidianWizard,
  slackWizard,
  // llm providers — OpenRouter first so the dashboard shows it as the
  // default pick (BYOK cloud, no GPU required). Ollama stays for users
  // who have a local GPU box.
  openrouterWizard,
  ollamaWizard,
  // memory backends
  pgvectorWizard,
  // webhooks
  webhooksWizard,
];

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
