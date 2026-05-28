/**
 * cortex-side przm-access token verification (ADR-021 Phase 3).
 *
 * Mints EdDSA tokens with `jose` (as the przm-access service would, using the
 * matching claim layout) and verifies them through `createAccessVerifier`,
 * covering the happy path and every rejection branch.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";
import {
  createAccessVerifier,
  AccessTokenError,
  type AccessVerifier,
} from "../src/access/verify-token.js";

const ISSUER = "https://access.przm.sh";
const AUDIENCE = "przm-platform";

let privateKey: KeyLike;
let publicJwk: JWK;
let verify: AccessVerifier;

/** Mint a token the way the service's issueToken does. */
async function mint(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expSec?: number; sub?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(opts.sub ?? "user-123")
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt();
  jwt.setExpirationTime(`${opts.expSec ?? 3600}s`);
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  verify = await createAccessVerifier({
    publicJwk: publicJwk as unknown as Record<string, unknown>,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
});

describe("createAccessVerifier", () => {
  it("verifies a well-formed token into a Principal", async () => {
    const token = await mint({ tenant: "tenant-a", role: "editor" }, { sub: "user-a" });
    const result = await verify(token);
    expect(result.principal).toEqual({ userId: "user-a", tenantId: "tenant-a", role: "editor" });
    expect(result.region).toBeNull();
  });

  it("carries the projects claim when present", async () => {
    const token = await mint({ tenant: "t", role: "admin", projects: ["p1", "p2"] });
    const result = await verify(token);
    expect(result.principal.projects).toEqual(["p1", "p2"]);
  });

  it("rejects a tampered signature (wrong key)", async () => {
    const other = await generateKeyPair("EdDSA", { extractable: true });
    const forged = await new SignJWT({ tenant: "t", role: "admin" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("u")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(other.privateKey);
    await expect(verify(forged)).rejects.toMatchObject({
      name: "AccessTokenError",
      code: "INVALID_SIGNATURE",
    });
  });

  it("rejects an expired token", async () => {
    const token = await mint({ tenant: "t", role: "viewer" }, { expSec: -10 });
    await expect(verify(token)).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("rejects a wrong audience", async () => {
    const token = await mint({ tenant: "t", role: "viewer" }, { audience: "someone-else" });
    await expect(verify(token)).rejects.toMatchObject({ code: "INVALID_AUDIENCE" });
  });

  it("rejects a wrong issuer", async () => {
    const token = await mint({ tenant: "t", role: "viewer" }, { issuer: "https://evil.example" });
    await expect(verify(token)).rejects.toMatchObject({ code: "INVALID_ISSUER" });
  });

  it("rejects malformed claims — missing tenant", async () => {
    const token = await mint({ role: "viewer" });
    await expect(verify(token)).rejects.toMatchObject({ code: "MALFORMED_CLAIMS" });
  });

  it("rejects malformed claims — invalid role", async () => {
    const token = await mint({ tenant: "t", role: "superuser" });
    await expect(verify(token)).rejects.toBeInstanceOf(AccessTokenError);
  });

  it("rejects malformed claims — non-string projects", async () => {
    const token = await mint({ tenant: "t", role: "admin", projects: [1, 2] });
    await expect(verify(token)).rejects.toMatchObject({ code: "MALFORMED_CLAIMS" });
  });
});
