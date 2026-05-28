# SBOM Consumption Guide

Every `przm-cortex` release ships a CycloneDX JSON Software Bill of Materials
(SBOM). This guide explains how a CISO or security team downloads and consumes it.

## Where to find the SBOM

**Option A — GitHub Release artifact (recommended)**

Every `v*` tag produces a release with the SBOM attached:

```sh
# List available releases
gh release list --repo OneNomad-LLC/cortex

# Download the SBOM for a specific tag
gh release download v0.7.0 \
  --repo OneNomad-LLC/cortex \
  --pattern '*sbom.json' \
  --output przm-cortex-sbom.json
```

**Option B — OCI artifact alongside the container image**

The SBOM is also attached to the GHCR image via cosign:

```sh
cosign download sbom \
  ghcr.io/onenomad-llc/przm-cortex:v0.7.0 \
  > przm-cortex-sbom.json
```

## Verifying the SBOM is authentic

Before feeding the SBOM into your SCA tool, confirm it was produced by the
official CI pipeline:

```sh
# Verify the container image signature (cosign keyless)
cosign verify \
  --certificate-identity-regexp 'https://github.com/OneNomad-LLC/cortex/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/onenomad-llc/przm-cortex:v0.7.0

# Verify SLSA Level 3 build provenance
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/slsa-framework/slsa-github-generator/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/onenomad-llc/przm-cortex:v0.7.0
```

Both commands should exit 0 and print the verified claims to stdout.

## Consuming the SBOM with your SCA tool

### Snyk

```sh
snyk sbom test --experimental --file=przm-cortex-sbom.json
```

### Grype (Anchore)

```sh
grype sbom:przm-cortex-sbom.json
```

### OWASP Dependency-Track

Upload the SBOM via the Dependency-Track UI or API:

```sh
curl -X POST https://<your-dependency-track>/api/v1/bom \
  -H "X-Api-Key: <api-key>" \
  -F "project=<project-uuid>" \
  -F "bom=@przm-cortex-sbom.json"
```

### GitHub Dependency Review / Dependabot

GitHub natively indexes CycloneDX SBOMs submitted via the Dependency Submission
API. The SBOM action in our CI pipeline handles this automatically for any repo
that forks or mirrors this one.

## SBOM format

The SBOM is CycloneDX 1.6 JSON (`application/vnd.cyclonedx+json`). It includes:

- Direct and transitive npm dependencies with exact resolved versions
- PURL (`pkg:npm/...`) identifiers for every component
- License expressions where available from package metadata
- The generating tool and schema version

## Freshness

A new SBOM is generated on every `v*` tag (release). The SBOM reflects the
dependency tree at the time the release was built from the pinned lockfile.
Between releases, the lockfile (`pnpm-lock.yaml`) is committed and can be
used to derive the dependency graph without a CI run.

## Questions

Contact security@onenomad.com or open an issue in this repository.
