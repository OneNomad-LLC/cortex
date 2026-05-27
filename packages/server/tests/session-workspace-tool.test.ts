import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspace,
  getActiveWorkspace,
  switchWorkspace,
} from "../src/cli/workspace/manager.js";
import {
  evictStaleSessions,
  runWithSession,
  setSessionWorkspace,
} from "../src/session-context.js";
import {
  getSessionWorkspace,
  setSessionWorkspaceTool,
} from "../src/mcp/tools/session-workspace.js";
import type { ToolContext } from "../src/mcp/tool.js";

/**
 * Tool-level behavior of get/set_session_workspace — the "hybrid"
 * resume: an unbound session still reports `workspace: null` (so the
 * onboarding prompt fires) but is handed the last-active workspace as a
 * `suggestedWorkspace`, and `set_session_workspace` persists that pointer
 * so the suggestion tracks the user's most recent choice.
 */
describe("session-workspace tool", () => {
  let tmp: string;
  const originalState = process.env.PRZM_CORTEX_STATE_PATH;
  const originalRoot = process.env.PRZM_CORTEX_WORKSPACES_ROOT;

  // The set handler only touches ctx.logger; stub the rest.
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as ToolContext;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-swt-"));
    process.env.PRZM_CORTEX_STATE_PATH = path.join(tmp, "state.json");
    process.env.PRZM_CORTEX_WORKSPACES_ROOT = path.join(tmp, "workspaces");
    evictStaleSessions(0);
  });

  afterEach(async () => {
    if (originalState === undefined) delete process.env.PRZM_CORTEX_STATE_PATH;
    else process.env.PRZM_CORTEX_STATE_PATH = originalState;
    if (originalRoot === undefined) delete process.env.PRZM_CORTEX_WORKSPACES_ROOT;
    else process.env.PRZM_CORTEX_WORKSPACES_ROOT = originalRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  describe("get_session_workspace", () => {
    it("suggests the last-active workspace when the session is unbound", async () => {
      await createWorkspace({ slug: "alpha" });
      await switchWorkspace("alpha");
      await runWithSession("s1", async () => {
        const out = await getSessionWorkspace.handler({}, ctx);
        expect(out.workspace).toBeNull();
        expect(out.suggestedWorkspace).toBe("alpha");
        expect(out.guidance).toContain("alpha");
      });
    });

    it("offers no suggestion when no active workspace exists", async () => {
      await runWithSession("s1", async () => {
        const out = await getSessionWorkspace.handler({}, ctx);
        expect(out.workspace).toBeNull();
        expect(out.suggestedWorkspace).toBeUndefined();
      });
    });

    it("offers no suggestion when the session explicitly chose 'none'", async () => {
      await createWorkspace({ slug: "alpha" });
      await switchWorkspace("alpha");
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", null);
        const out = await getSessionWorkspace.handler({}, ctx);
        expect(out.workspace).toBeNull();
        expect(out.suggestedWorkspace).toBeUndefined();
      });
    });

    it("reports the bound workspace and no suggestion when bound", async () => {
      await createWorkspace({ slug: "alpha" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "alpha");
        const out = await getSessionWorkspace.handler({}, ctx);
        expect(out.workspace).toBe("alpha");
        expect(out.suggestedWorkspace).toBeUndefined();
      });
    });
  });

  describe("set_session_workspace", () => {
    it("records the bound workspace as the new last-active pointer", async () => {
      await createWorkspace({ slug: "alpha" });
      await createWorkspace({ slug: "beta" });
      await switchWorkspace("alpha");
      await runWithSession("s1", async () => {
        await setSessionWorkspaceTool.handler({ slug: "beta" }, ctx);
      });
      const active = await getActiveWorkspace();
      expect(active?.slug).toBe("beta");
    });

    it("leaves the last-active pointer untouched when binding to 'none'", async () => {
      await createWorkspace({ slug: "alpha" });
      await switchWorkspace("alpha");
      await runWithSession("s1", async () => {
        await setSessionWorkspaceTool.handler({ slug: "none" }, ctx);
      });
      const active = await getActiveWorkspace();
      expect(active?.slug).toBe("alpha");
    });
  });
});
