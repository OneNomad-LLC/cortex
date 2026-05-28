/**
 * ADR-021 Phase 3 — the session→tenant threading the RLS path depends on.
 *
 * The HTTP transport stamps a verified Principal on the session; the memory
 * client reads `getCurrentTenantId()` and passes it into the tenant-scoped
 * backend ops. These assert that contract: principal in → tenantId out of the
 * ALS-bound session, and absent principal → no scope (single-tenant default).
 */

import { describe, it, expect } from "vitest";
import {
  runWithSession,
  setSessionPrincipal,
  getCurrentPrincipal,
  getCurrentTenantId,
  getCurrentSessionId,
} from "../src/session-context.js";

describe("session principal threading", () => {
  it("exposes the stamped principal's tenantId on the current session", () => {
    runWithSession("sp-1", () => {
      const id = getCurrentSessionId()!;
      setSessionPrincipal(id, { userId: "u1", tenantId: "tenant-x", role: "admin" });
      expect(getCurrentTenantId()).toBe("tenant-x");
      expect(getCurrentPrincipal()?.role).toBe("admin");
    });
  });

  it("clearing the principal removes the tenant scope (no cross-request leak)", () => {
    runWithSession("sp-2", () => {
      const id = getCurrentSessionId()!;
      setSessionPrincipal(id, { userId: "u", tenantId: "t", role: "viewer" });
      setSessionPrincipal(id, undefined);
      expect(getCurrentTenantId()).toBeUndefined();
      expect(getCurrentPrincipal()).toBeUndefined();
    });
  });

  it("an unauthenticated session has no tenant scope (single-tenant default)", () => {
    runWithSession("sp-3", () => {
      expect(getCurrentTenantId()).toBeUndefined();
    });
  });
});
