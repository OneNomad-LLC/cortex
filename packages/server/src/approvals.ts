import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export type ApprovalStatus = "draft" | "in_review" | "approved" | "revoked";

export interface ApprovalRecord {
  status: ApprovalStatus;
  reviewer?: string;
  note?: string;
  decidedAt: string;
  /** Trace id of the tool call that made the decision, when available. */
  trace_id?: string;
}

export interface ApprovalsFile {
  /** Schema version so we can migrate the shape later. */
  version: 1;
  /** Map of source_id → decision. */
  sources: Record<string, ApprovalRecord>;
}

export function defaultApprovalsPath(): string {
  return (
    process.env.CORTEX_APPROVALS_PATH ??
    path.join(os.homedir(), ".cortex", "approvals.json")
  );
}

/**
 * Approvals override the `status` field stored in the memory's metadata.
 * The file is the source of truth because Engram's metadata-update story
 * is not yet wired; `approve_research` re-ingests too but that may
 * dedupe server-side. Read-at-query-time handles both paths.
 */
export async function readApprovals(
  filePath: string = defaultApprovalsPath(),
): Promise<ApprovalsFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ApprovalsFile;
    if (parsed.version !== 1) {
      throw new Error(
        `approvals: unsupported schema version ${parsed.version}`,
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, sources: {} };
    }
    throw err;
  }
}

export async function writeApprovals(
  file: ApprovalsFile,
  filePath: string = defaultApprovalsPath(),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export async function setApproval(args: {
  sourceId: string;
  status: ApprovalStatus;
  reviewer?: string;
  note?: string;
  traceId?: string;
  filePath?: string;
}): Promise<ApprovalRecord> {
  const file = await readApprovals(args.filePath);
  const record: ApprovalRecord = {
    status: args.status,
    decidedAt: new Date().toISOString(),
    ...(args.reviewer ? { reviewer: args.reviewer } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.traceId ? { trace_id: args.traceId } : {}),
  };
  file.sources[args.sourceId] = record;
  await writeApprovals(file, args.filePath);
  return record;
}

export async function getApproval(
  sourceId: string,
  filePath?: string,
): Promise<ApprovalRecord | undefined> {
  const file = await readApprovals(filePath);
  return file.sources[sourceId];
}
