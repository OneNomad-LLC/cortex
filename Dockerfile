# syntax=docker/dockerfile:1.7
# Cortex Cloud base image. Runs the MCP server + HTTP API (port 4141)
# in a single Node process. The dashboard UI moved to pyre-web
# (2026-05-14); pyre-web's per-tenant proxy talks to /api/* here, so
# the runtime image no longer carries Next.js or the dashboard build.
#
# Build remotely on Fly (no local Docker required):
#   fly deploy -a cortex-base --build-only --push
#
# Or build + push locally if Docker is installed:
#   docker build -t registry.fly.io/cortex-base:latest .
#   fly auth docker
#   docker push registry.fly.io/cortex-base:latest

# ── Stage 1: install workspace dependencies ─────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Native build deps for any postinstall that compiles C++ (onnxruntime
# from @xenova/transformers, better-sqlite, etc.). node:22-slim doesn't
# ship build-essential or python3 by default, so npm postinstalls that
# call node-gyp / cmake fail with "make: not found" or "no acceptable
# python". The cost is ~150MB on the deps stage only — runtime image
# doesn't carry these.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential python3 cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY schemas ./schemas
RUN pnpm install --frozen-lockfile

# ── Stage 2: build the workspace ────────────────────────────────────
FROM deps AS build
WORKDIR /app
RUN pnpm -r --filter='!@onenomad/cortex-dashboard' run build

# ── Stage 3: runtime image ──────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# `git` powers `cortex module install <git-url>` and the `ingest_repo`
# MCP tool's git-URL path. `ca-certificates` is NOT implicit in
# node:22-slim — without it, git's TLS verification fails on every
# clone with "server certificate verification failed. CAfile: none".
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Prune the server package + its runtime deps into a self-contained
# tree. With the dashboard gone, this is the entire runtime — no need
# to graft anything back into a workspace layout.
COPY --from=build /app /app
RUN pnpm -r --prod deploy --filter=@onenomad/cortex /runtime-pkg \
    && rm -rf /app/packages/server/node_modules \
    && mv /runtime-pkg/node_modules /app/packages/server/node_modules

WORKDIR /app/packages/server

# Defaults for Fly Machines. Auth tokens are injected per-tenant by the
# pyre-web provisioner. CORTEX_API_ENABLED flips on so pyre-web's
# tenant proxy can reach /api/* — the committed cortex.yaml defaults
# api.enabled to false for laptop installs.
ENV CORTEX_MCP_TRANSPORT=http
ENV CORTEX_MCP_HOST=0.0.0.0
ENV CORTEX_MCP_PORT=3100
ENV CORTEX_API_ENABLED=true
ENV CORTEX_API_HOST=0.0.0.0
ENV CORTEX_API_PORT=4141

EXPOSE 3100 4141

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
