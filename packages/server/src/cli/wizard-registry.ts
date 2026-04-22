import type { WizardModule } from "@cortex/core";
import { bitbucketWizard } from "@cortex/adapter-bitbucket";
import { confluenceWizard } from "@cortex/adapter-confluence";
import { githubWizard } from "@cortex/adapter-github";
import { gmailWizard } from "@cortex/adapter-gmail";
import { googleCalendarWizard } from "@cortex/adapter-google-calendar";
import { googleDriveWizard } from "@cortex/adapter-google-drive";
import { jiraWizard } from "@cortex/adapter-jira";
import { linearWizard } from "@cortex/adapter-linear";
import { loomWizard } from "@cortex/adapter-loom";
import { notionWizard } from "@cortex/adapter-notion";
import { obsidianWizard } from "@cortex/adapter-obsidian";
import { slackWizard } from "@cortex/adapter-slack";
import { pgvectorWizard } from "@cortex/memory-pgvector";
import { ollamaWizard } from "@cortex/provider-ollama";
import { openrouterWizard } from "@cortex/provider-openrouter";
import { webhooksWizard } from "./webhooks-wizard.js";

/**
 * Static registry of wizard specs known to the CLI.
 *
 * Each adapter / provider / toolkit that wants guided setup exports a
 * `WizardModule` spec; we list them here explicitly (same ADR-009 pattern
 * as the adapter + provider registries). Listing here is the single place
 * new modules land when their wizards ship.
 *
 * Google adapters (gmail, google-calendar, google-drive) rely on a
 * separate `cortex google-login` subcommand for the OAuth handshake —
 * the wizard flow here only collects adapter-specific config and
 * assumes the shared refresh token is already on disk.
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
  gmailWizard,
  googleCalendarWizard,
  googleDriveWizard,
  // llm providers
  ollamaWizard,
  openrouterWizard,
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
