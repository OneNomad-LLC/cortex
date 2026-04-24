import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspace,
  switchWorkspace,
} from "../src/cli/workspace/manager.js";
import { evictStaleSessions, runWithSession, setSessionWorkspace } from "../src/session-context.js";
import {
  NoWorkspaceBoundError,
  maybeSessionWorkspace,
  requireSessionWorkspace,
  resolveSessionWorkspaceSlug,
} from "../src/session-workspace-helpers.js";

/**
 * These tests exercise the resolution chain:
 *   session binding → active workspace (state.json) → throw.
 * Each test gets its own tmp workspace root + state file so they
 * don't collide, and evicts all sessions up front so the ALS map
 * doesn't leak a binding from a previous test.
 */
describe("session-workspace-helpers", () => {
  let tmp: string;
  const originalState = process.env.CORTEX_STATE_PATH;
  const originalRoot = process.env.CORTEX_WORKSPACES_ROOT;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "cortex-swh-"));
    process.env.CORTEX_STATE_PATH = path.join(tmp, "state.json");
    process.env.CORTEX_WORKSPACES_ROOT = path.join(tmp, "workspaces");
    evictStaleSessions(0);
  });

  afterEach(async () => {
    if (originalState === undefined) delete process.env.CORTEX_STATE_PATH;
    else process.env.CORTEX_STATE_PATH = originalState;
    if (originalRoot === undefined) delete process.env.CORTEX_WORKSPACES_ROOT;
    else process.env.CORTEX_WORKSPACES_ROOT = originalRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  describe("resolveSessionWorkspaceSlug", () => {
    it("returns the session binding when set", async () => {
      await createWorkspace({ slug: "alpha" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "alpha");
        expect(await resolveSessionWorkspaceSlug()).toBe("alpha");
      });
    });

    it("returns null when the session is explicitly in no-workspace mode", async () => {
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", null);
        expect(await resolveSessionWorkspaceSlug()).toBeNull();
      });
    });

    it("falls back to the CLI active workspace when the session is unbound", async () => {
      await createWorkspace({ slug: "fallback" });
      await switchWorkspace("fallback");
      await runWithSession("s1", async () => {
        expect(await resolveSessionWorkspaceSlug()).toBe("fallback");
      });
    });

    it("returns undefined when nothing is bound and no active workspace exists", async () => {
      await runWithSession("s1", async () => {
        expect(await resolveSessionWorkspaceSlug()).toBeUndefined();
      });
    });

    it("session binding beats the CLI active pointer", async () => {
      await createWorkspace({ slug: "legacy" });
      await createWorkspace({ slug: "bound" });
      await switchWorkspace("legacy");
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "bound");
        expect(await resolveSessionWorkspaceSlug()).toBe("bound");
      });
    });
  });

  describe("requireSessionWorkspace", () => {
    it("returns a full Workspace object when the session is bound", async () => {
      const created = await createWorkspace({ slug: "work" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "work");
        const ws = await requireSessionWorkspace();
        expect(ws.slug).toBe("work");
        expect(ws.path).toBe(created.path);
        expect(ws.configPath).toBe(created.configPath);
      });
    });

    it("throws NoWorkspaceBoundError when the session has no workspace", async () => {
      await runWithSession("s1", async () => {
        await expect(requireSessionWorkspace()).rejects.toBeInstanceOf(
          NoWorkspaceBoundError,
        );
      });
    });

    it("throws NoWorkspaceBoundError when explicitly in no-workspace mode", async () => {
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", null);
        await expect(requireSessionWorkspace()).rejects.toBeInstanceOf(
          NoWorkspaceBoundError,
        );
      });
    });

    it("throws a helpful error when bound to a workspace that no longer exists on disk", async () => {
      await createWorkspace({ slug: "gone" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "gone");
        await rm(path.join(tmp, "workspaces", "gone"), {
          recursive: true,
          force: true,
        });
        await expect(requireSessionWorkspace()).rejects.toThrow(
          /no longer exists on disk/i,
        );
      });
    });

    it("falls back to the active workspace when the session is unbound", async () => {
      await createWorkspace({ slug: "active" });
      await switchWorkspace("active");
      await runWithSession("s1", async () => {
        const ws = await requireSessionWorkspace();
        expect(ws.slug).toBe("active");
      });
    });
  });

  describe("maybeSessionWorkspace", () => {
    it("returns the Workspace when bound", async () => {
      await createWorkspace({ slug: "maybe" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "maybe");
        const ws = await maybeSessionWorkspace();
        expect(ws?.slug).toBe("maybe");
      });
    });

    it("returns null when explicitly in no-workspace mode", async () => {
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", null);
        expect(await maybeSessionWorkspace()).toBeNull();
      });
    });

    it("returns null when nothing resolvable", async () => {
      await runWithSession("s1", async () => {
        expect(await maybeSessionWorkspace()).toBeNull();
      });
    });

    it("returns null — rather than throwing — when bound slug is missing on disk", async () => {
      await createWorkspace({ slug: "ghost" });
      await runWithSession("s1", async () => {
        setSessionWorkspace("s1", "ghost");
        await rm(path.join(tmp, "workspaces", "ghost"), {
          recursive: true,
          force: true,
        });
        expect(await maybeSessionWorkspace()).toBeNull();
      });
    });
  });
});
