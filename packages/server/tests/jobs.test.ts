import { afterEach, describe, expect, it } from "vitest";
import { jobs } from "../src/mcp/jobs.js";

afterEach(() => {
  jobs._reset();
});

/**
 * In-memory job registry. The async-mode ingest tools (currently
 * ingest_repo with async:true) and the kb_job_status MCP tool both
 * lean on this. Tests pin the lifecycle + retention semantics.
 */
describe("jobs registry", () => {
  it("create() returns a job in the queued state with a uuid", () => {
    const job = jobs.create({ kind: "ingest_repo" });
    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(job.kind).toBe("ingest_repo");
    expect(job.status).toBe("queued");
    expect(job.startedAtMs).toBeNull();
    expect(job.finishedAtMs).toBeNull();
    expect(job.result).toBeNull();
    expect(job.error).toBeNull();
  });

  it("start() flips status to running and stamps startedAtMs", () => {
    const job = jobs.create({ kind: "ingest_repo" });
    jobs.start(job.id);
    const fetched = jobs.get(job.id);
    expect(fetched?.status).toBe("running");
    expect(fetched?.startedAtMs).toBeGreaterThan(0);
    expect(fetched?.finishedAtMs).toBeNull();
  });

  it("progress() merges patch into the existing progress object", () => {
    const job = jobs.create({ kind: "ingest_repo" });
    jobs.progress(job.id, { totalUnits: 100, message: "starting" });
    jobs.progress(job.id, { doneUnits: 25 });
    expect(jobs.get(job.id)?.progress).toEqual({
      totalUnits: 100,
      message: "starting",
      doneUnits: 25,
    });
  });

  it("complete() flips status, stamps finishedAtMs, stores the result", () => {
    const job = jobs.create({ kind: "ingest_url" });
    jobs.complete(job.id, { ingested: 42 });
    const fetched = jobs.get(job.id);
    expect(fetched?.status).toBe("completed");
    expect(fetched?.finishedAtMs).toBeGreaterThan(0);
    expect(fetched?.result).toEqual({ ingested: 42 });
    expect(fetched?.error).toBeNull();
  });

  it("fail() captures Error.message and stamps finishedAtMs", () => {
    const job = jobs.create({ kind: "ingest_repo" });
    jobs.fail(job.id, new Error("git clone timed out"));
    const fetched = jobs.get(job.id);
    expect(fetched?.status).toBe("failed");
    expect(fetched?.error).toBe("git clone timed out");
    expect(fetched?.finishedAtMs).toBeGreaterThan(0);
  });

  it("fail() coerces non-Error throws to string", () => {
    const job = jobs.create({ kind: "ingest_repo" });
    jobs.fail(job.id, "string error");
    expect(jobs.get(job.id)?.error).toBe("string error");
  });

  it("get() returns undefined for unknown ids", () => {
    expect(jobs.get("not-a-uuid")).toBeUndefined();
  });

  it("ignores updates to unknown ids without throwing", () => {
    expect(() => jobs.start("missing")).not.toThrow();
    expect(() => jobs.progress("missing", { x: 1 })).not.toThrow();
    expect(() => jobs.complete("missing", null)).not.toThrow();
    expect(() => jobs.fail("missing", new Error("x"))).not.toThrow();
  });

  it("preserves multiple in-flight jobs distinctly", () => {
    const a = jobs.create({ kind: "ingest_repo" });
    const b = jobs.create({ kind: "ingest_url" });
    jobs.progress(a.id, { doneUnits: 5 });
    jobs.complete(b.id, { ingested: 1 });
    expect(jobs.get(a.id)?.status).toBe("queued");
    expect(jobs.get(a.id)?.progress).toEqual({ doneUnits: 5 });
    expect(jobs.get(b.id)?.status).toBe("completed");
  });
});
