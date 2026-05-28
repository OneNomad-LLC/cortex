# Security

## Reporting a vulnerability

Email **security@onenomad.com** with a description of the issue, reproduction
steps, and the version(s) affected. Do not open a public GitHub issue — please
use email so we can coordinate a fix before disclosure.

PGP key fingerprint: `<TO-BE-PROVIDED>` — the key will be published at
`https://onenomad.com/.well-known/security.asc` before the first production
release. Until then, plain email is fine; we do not require encrypted reports.

We acknowledge within **5 business days** and aim to release a fix or
documented mitigation within **30 days**. If the issue requires coordination
with an upstream dependency, we will keep you informed and extend the timeline
only with your agreement.

## Supported versions

| Track   | Receives fixes for        |
|---------|---------------------------|
| Latest minor of each major | All severities |
| Older minors | CVSS >= 7.0 only |

We do not backport security fixes beyond the current minor unless a critical
(CVSS >= 9.0) issue affects a widely-deployed older version.

## Supply-chain verification

Every release tag produces artifacts you can verify independently:

**Docker image signature (cosign keyless):**
```sh
cosign verify \
  --certificate-identity-regexp 'https://github.com/OneNomad-LLC/cortex/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/onenomad-llc/przm-cortex:<tag>
```

**SLSA Level 3 provenance:**
```sh
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/slsa-framework/slsa-github-generator/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/onenomad-llc/przm-cortex:<tag>
```

**SBOM (CycloneDX JSON):**
```sh
# From the GitHub Release page
gh release download <tag> --pattern '*sbom.json' --output sbom.json

# Or attached as an OCI artifact alongside the image
cosign download sbom ghcr.io/onenomad-llc/przm-cortex:<tag>
```

See `docs/security/SBOM.md` for the full CISO consumption guide.

## Hall of fame

Researchers who responsibly disclose valid vulnerabilities will be listed here
(with their consent) after the fix ships.

| Researcher | Issue | Fixed in |
|------------|-------|----------|
| — | — | — |

## Advisories

See `docs/security/ADVISORIES.md` for the full list of past CVEs and
mean-time-to-patch history.
