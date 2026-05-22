/**
 * Smoke coverage for the `api()` wrapper. Focused on the contracts
 * the rest of the SPA relies on:
 *   - X-Cortex-Dashboard auto-stamped on mutating methods, absent on GET
 *   - credentials: include always
 *   - 401 throws ApiUnauthorizedError + dispatches window event
 *   - 403 csrf_required throws ApiCsrfError
 *   - other non-2xx throws ApiError
 *   - JSON bodies get Content-Type stamped; FormData passes through
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  api,
  ApiCsrfError,
  ApiError,
  ApiUnauthorizedError,
} from "./api";

interface MockResponseInit {
  status?: number;
  body?: unknown;
  bodyText?: string;
  contentType?: string;
}

function makeResponse({
  status = 200,
  body,
  bodyText,
  contentType = "application/json",
}: MockResponseInit = {}): Response {
  const text =
    bodyText !== undefined
      ? bodyText
      : body !== undefined
        ? JSON.stringify(body)
        : "";
  return new Response(text, {
    status,
    headers: { "content-type": contentType },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

let calls: FetchCall[];
let nextResponses: Response[];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  nextResponses = [];
  // Stub fetch — every call records the args + pops the next queued
  // response (defaults to a 200 empty JSON).
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === "string" ? input : input.toString(),
        init: init ?? {},
      });
      return nextResponses.shift() ?? makeResponse({ body: {} });
    },
  ) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("api() — request shaping", () => {
  it("does NOT add X-Cortex-Dashboard on GET requests", async () => {
    nextResponses.push(makeResponse({ body: { ok: true } }));
    await api("/api/dashboard/auth/whoami");
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.has("X-Cortex-Dashboard")).toBe(false);
    expect(calls[0]!.init.credentials).toBe("include");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("adds X-Cortex-Dashboard: 1 on POST", async () => {
    nextResponses.push(makeResponse({ body: { ok: true } }));
    await api("/api/dashboard/auth/login", {
      method: "POST",
      body: JSON.stringify({ token: "abc" }),
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Cortex-Dashboard")).toBe("1");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("adds X-Cortex-Dashboard on PUT/PATCH/DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      nextResponses.push(makeResponse({ body: { ok: true } }));
      // eslint-disable-next-line no-await-in-loop
      await api("/api/test", { method });
    }
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("X-Cortex-Dashboard")).toBe("1");
    }
  });

  it("respects an explicit X-Cortex-Dashboard header from the caller", async () => {
    nextResponses.push(makeResponse({ body: { ok: true } }));
    await api("/api/test", {
      method: "POST",
      headers: { "X-Cortex-Dashboard": "custom" },
    });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("X-Cortex-Dashboard")).toBe("custom");
  });

  it("does NOT stamp Content-Type when the body is FormData", async () => {
    nextResponses.push(makeResponse({ body: { ok: true } }));
    const fd = new FormData();
    fd.append("file", new Blob(["x"]), "x.txt");
    await api("/api/test", { method: "POST", body: fd });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.has("Content-Type")).toBe(false);
  });
});

describe("api() — response handling", () => {
  it("returns parsed JSON on 200", async () => {
    nextResponses.push(makeResponse({ body: { hello: "world" } }));
    const result = await api<{ hello: string }>("/api/test");
    expect(result.hello).toBe("world");
  });

  it("throws ApiUnauthorizedError on 401 and dispatches event", async () => {
    nextResponses.push(makeResponse({ status: 401, body: { error: "unauthorized" } }));
    const eventSpy = vi.fn();
    window.addEventListener("cortex:unauthorized", eventSpy);
    try {
      await expect(api("/api/test")).rejects.toBeInstanceOf(ApiUnauthorizedError);
    } finally {
      window.removeEventListener("cortex:unauthorized", eventSpy);
    }
    expect(eventSpy).toHaveBeenCalledTimes(1);
  });

  it("throws ApiCsrfError on 403 csrf_required", async () => {
    nextResponses.push(
      makeResponse({ status: 403, body: { error: "csrf_required" } }),
    );
    await expect(api("/api/test", { method: "POST" })).rejects.toBeInstanceOf(
      ApiCsrfError,
    );
  });

  it("throws ApiError on a generic non-2xx", async () => {
    nextResponses.push(makeResponse({ status: 500, body: { error: "boom" } }));
    await expect(api("/api/test")).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined on 204 No Content", async () => {
    nextResponses.push(new Response(null, { status: 204 }));
    const result = await api("/api/test", { method: "DELETE" });
    expect(result).toBeUndefined();
  });
});
