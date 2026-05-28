/**
 * przm-access token verification — the cortex (plane) side of ADR-021.
 *
 * cortex receives requests bearing a scoped EdDSA token minted by the
 * przm-access service and reconstructs a `Principal` from it. Verification uses
 * ONLY the public key — cortex can verify but never forge ("decisions central,
 * enforcement local"). The `Principal` shape + `Role` guard come from the thin
 * `@onenomad/przm-access` contract package; the verify logic lives here (not in
 * the contract) so the contract stays near-zero-dep — it does not pull `jose`.
 *
 * This mirrors the issuer-side verify in the przm-access service, minus the
 * private key. Keep the claim mapping in sync with the service's `issueToken`.
 */

import { importJWK, jwtVerify, errors as joseErrors } from "jose";
import type { JWK } from "jose";
import { isRole } from "@onenomad/przm-access";
import type { Principal } from "@onenomad/przm-access";

export type AccessTokenErrorCode =
  | "INVALID_SIGNATURE"
  | "TOKEN_EXPIRED"
  | "INVALID_AUDIENCE"
  | "INVALID_ISSUER"
  | "MALFORMED_CLAIMS";

/** Thrown for every verification failure; switch on `.code` for handling. */
export class AccessTokenError extends Error {
  readonly code: AccessTokenErrorCode;
  constructor(code: AccessTokenErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AccessTokenError";
    this.code = code;
  }
}

export interface AccessVerifyConfig {
  /** The przm-access public verification key, as a JWK object. */
  publicJwk: Record<string, unknown>;
  /** Expected `iss` claim. */
  issuer: string;
  /** Expected `aud` claim. */
  audience: string;
}

/** A verifier bound to an imported key: token string → resolved Principal. */
export type AccessVerifier = (token: string) => Promise<Principal>;

/**
 * Import the public key once and return a verifier. Call at boot (the key
 * import is async and need only happen once); the returned function verifies
 * each request token cheaply.
 */
export async function createAccessVerifier(
  cfg: AccessVerifyConfig,
): Promise<AccessVerifier> {
  const key = await importJWK(cfg.publicJwk as unknown as JWK, "EdDSA");

  return async function verify(token: string): Promise<Principal> {
    let payload: Record<string, unknown>;
    try {
      const res = await jwtVerify(token, key, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms: ["EdDSA"],
      });
      payload = res.payload as Record<string, unknown>;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new AccessTokenError("TOKEN_EXPIRED", "Token has expired", err);
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        if (err.claim === "aud") {
          throw new AccessTokenError("INVALID_AUDIENCE", "Invalid audience claim", err);
        }
        if (err.claim === "iss") {
          throw new AccessTokenError("INVALID_ISSUER", "Invalid issuer claim", err);
        }
        throw new AccessTokenError(
          "INVALID_SIGNATURE",
          `Claim validation failed (${err.claim}): ${err.message}`,
          err,
        );
      }
      throw new AccessTokenError(
        "INVALID_SIGNATURE",
        "Token signature verification failed",
        err,
      );
    }

    const userId = payload["sub"];
    if (typeof userId !== "string" || userId.length === 0) {
      throw new AccessTokenError("MALFORMED_CLAIMS", "Missing or empty 'sub' claim");
    }
    const tenantId = payload["tenant"];
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new AccessTokenError("MALFORMED_CLAIMS", "Missing or empty 'tenant' claim");
    }
    const role = payload["role"];
    if (!isRole(role)) {
      throw new AccessTokenError("MALFORMED_CLAIMS", `Invalid role claim: ${String(role)}`);
    }

    const rawProjects = payload["projects"];
    if (rawProjects !== undefined) {
      if (
        !Array.isArray(rawProjects) ||
        !rawProjects.every((p): p is string => typeof p === "string")
      ) {
        throw new AccessTokenError(
          "MALFORMED_CLAIMS",
          "Invalid 'projects' claim: must be an array of strings",
        );
      }
      return { userId, tenantId, role, projects: rawProjects };
    }
    return { userId, tenantId, role };
  };
}
