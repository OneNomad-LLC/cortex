import type { WizardModule } from "@onenomad/cortex-core";
import { openrouterConfigSchema, type OpenRouterConfig } from "./provider.js";

export const openrouterWizard: WizardModule<OpenRouterConfig> = {
  id: "openrouter",
  name: "OpenRouter",
  category: "provider",
  description:
    "BYOK cloud LLM access via OpenRouter. Single API key gets you " +
    "Anthropic, OpenAI, Google, Mistral, and more.",
  configSchema: openrouterConfigSchema,
  steps: [
    {
      key: "baseUrl",
      prompt: "OpenRouter API base URL",
      type: "text",
      defaultValue: "https://openrouter.ai/api/v1",
      pattern: /^https?:\/\/.+/,
      patternHint: "must be an https:// URL",
    },
    {
      key: "appTitle",
      prompt: "App title reported in OpenRouter's activity feed",
      type: "text",
      defaultValue: "Cortex",
    },
    {
      key: "referer",
      prompt:
        "HTTP referer reported to OpenRouter. Leave the default unless you want it to show up under a specific URL.",
      type: "text",
      defaultValue: "https://cortex.local",
      pattern: /^https?:\/\/.+/,
      patternHint: "must be an http:// or https:// URL",
    },
  ],
  secrets: [
    {
      envVar: "OPENROUTER_API_KEY",
      prompt: "OpenRouter API key (create at openrouter.ai/keys)",
      type: "password",
      required: true,
    },
  ],
};
