import { defineManifest } from "@crxjs/vite-plugin";

/**
 * MV3 manifest for the Cortex browser extension.
 *
 * Hosts:
 *   - <all_urls> is required so the agentic browser bridge can run
 *     `chrome.scripting.executeScript` against whatever tab Claude
 *     wants to drive. Without it, tool calls would fail on any site
 *     the user isn't actively clicking into.
 *   - The localhost entries stay for clarity even though they're
 *     covered by <all_urls>.
 *
 * Permissions:
 *   - `tabs` — cross-tab url/title metadata for the bridge's
 *     tab-list announcements.
 *   - `scripting` — executeScript for reads + clicks + fills.
 *   - `activeTab` — keeps the selection-ingest button responsive
 *     even on sites the user hasn't given us blanket access to.
 *   - `alarms` — MV3 service-worker keepalive. Chrome evicts idle
 *     workers after ~30s, killing our WebSocket to Cortex; a 25s
 *     alarm keeps the SW warm so Claude's browser tool calls don't
 *     hit "no session" between uses.
 */
export default defineManifest({
  manifest_version: 3,
  name: "Cortex",
  description: "Ingest web content into your local Cortex memory",
  version: "0.2.0",
  action: {
    default_popup: "src/popup/index.html",
    default_title: "Cortex",
    default_icon: {
      16: "src/assets/icon-16.png",
      48: "src/assets/icon-48.png",
      128: "src/assets/icon-128.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: [
    "storage",
    "tabs",
    "activeTab",
    "contextMenus",
    "scripting",
    "alarms",
  ],
  host_permissions: ["<all_urls>"],
  icons: {
    16: "src/assets/icon-16.png",
    48: "src/assets/icon-48.png",
    128: "src/assets/icon-128.png",
  },
});
