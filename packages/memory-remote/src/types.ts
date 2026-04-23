import type { EngramAccess, HealthStatus } from "@onenomad/cortex-core";

/**
 * Argument shape for an Engram search call. Kept in sync with the stdio
 * client's `EngramSearchArgs` (server/src/clients/engram.ts) so the two
 * implementations are structurally interchangeable.
 *
 * Deliberate duplication rather than upstream dep: the server's types
 * carry a small amount of server-side coupling (logger, subprocess),
 * and we want this package to stay dependency-light.
 */
export interface EngramSearchArgs {
  query: string;
  limit?: number;
  project?: string;
  type?: string;
  source?: string;
  sinceIso?: string;
  domain?: string;
}

export interface EngramMemory {
  id: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  type?: string;
  /**
   * Populated by `createRemoteEngramClient` with the caller-supplied
   * backend slug, so a federated wrapper can show provenance per row.
   */
  _backend?: string;
}

/**
 * Full remote client surface — same shape as the stdio `EngramClient`
 * in the server package.
 */
export interface RemoteEngramClient extends EngramAccess {
  search(args: EngramSearchArgs): Promise<EngramMemory[]>;
  shutdown(): Promise<void>;
}

export type { HealthStatus };
