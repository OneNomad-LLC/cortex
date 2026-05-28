# Reproducible Builds

`przm-cortex` aims to produce byte-for-byte identical Docker images across
independent builds of the same source commit. The `reproducible-build` CI job
(`.github/workflows/reproducible-build.yml`) builds the image twice per commit
and diffs the manifests as a signal, not a hard gate.

## Current status

**Best-effort.** The build is largely reproducible for the application layer
(TypeScript compilation produces deterministic output given the same tsc
version and lockfile). Known non-determinism lives in the base image and OS
layer, documented below.

## Known sources of non-determinism

### 1. `apt-get install` in the runtime stage

The Dockerfile runs:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git
```

`apt-get update` fetches the current package index, and `apt-get install`
resolves to the latest available `git` package at build time. If the Debian
package repository updates `git` between two builds, the layer hash differs.

**Mitigation path:** Pin the `git` package version:
```dockerfile
RUN apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u1
```
We have not done this yet because it requires manual updates on each `git`
security release. Tracked for a future task.

### 2. Base image `node:22-slim` digest

`node:22-slim` is a mutable tag. Across two builds on different days, the
underlying Debian slim image may have been updated with security patches.

**Mitigation path:** Pin to the image digest in the Dockerfile:
```dockerfile
FROM node:22-slim@sha256:<digest> AS deps
```
Update the digest intentionally on each Node.js security release rather than
pulling automatically.

### 3. `corepack prepare pnpm@9.12.0 --activate`

Corepack fetches the pnpm binary from the npm registry. If the registry
returns a slightly different tarball (unlikely but possible with CDN caching
differences), the layer hash differs.

**Mitigation path:** Copy a pre-downloaded pnpm binary into the image or use
`--offline` mode after pre-seeding the corepack cache in the base image.
Low priority — the pnpm version is pinned to a patch-level tag.

### 4. `pnpm install --frozen-lockfile` network resolution order

With `--frozen-lockfile`, pnpm resolves all packages from the lockfile, but
the download order from the registry CDN can affect intermediate layer
timestamps. This typically does not affect the final image manifest because
`node_modules` contents are determined by the lockfile, not the download order.

**Assessment:** This is not a real source of non-determinism in practice;
including it here for completeness.

## What the CI check verifies

The `reproducible-build` job compares `docker inspect` output (minus the
mutable `Id`, `RepoTags`, and `RepoDigests` fields) between two sequential
builds with `no-cache: true`. It uploads the diff as a workflow artifact.

A non-empty diff triggers a warning annotation on the commit — it does not
fail the build or block a release.

## Roadmap

- [ ] Pin `node:22-slim` by digest in Dockerfile
- [ ] Pin `git` apt package version
- [ ] Add SOURCE_DATE_EPOCH support to `tsc` output (TypeScript does not
      currently honour this; tracked upstream)
- [ ] Evaluate `docker buildx build --reproducible=true` (BuildKit
      reproducibility mode) once it stabilizes
