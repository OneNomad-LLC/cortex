# syntax=docker/dockerfile:1.7
# Multi-stage build for @onenomad/cortex.
#
# Base image is node:22-slim (Debian/glibc). Alpine/musl was tried
# first but LanceDB's musl binary hard-requires AVX-512 CPU
# instructions that most consumer laptops lack — the glibc build
# does runtime CPU detection and works on a broader baseline.
# Node 22 is required because @onenomad/cortex-cache-sqlite imports
# node:sqlite (stable in 22.16+).
#
# Stage 1 (deps): install the workspace with pnpm so the @onenomad/*
#   links resolve through the monorepo root.
# Stage 2 (build): tsc --build across the workspace.
# Stage 3 (runtime): prune to a self-contained deploy of the server
#   package plus its engram/persona npm dependencies.
#
# Build from the repo root:
#   docker build -f packages/server/Dockerfile -t cortex:latest .

FROM node:22-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifest-only pass: cacheable against package.json churn.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
RUN pnpm -r run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# `git` powers `cortex module install <git-url>` — the dashboard route
# and the CLI both call `git clone` against the runtime image. ~5MB.
# `ca-certificates` is implicit in node:20-slim; no need to add.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy everything from build, then produce a pruned deploy tree for the
# server package — this strips dev deps and flattens workspace symlinks.
COPY --from=build /app /app
RUN pnpm -r --prod deploy --filter=@onenomad/cortex /runtime-pkg

WORKDIR /runtime-pkg

# Default runtime knobs. Compose overrides most of these.
#
# CORTEX_DASHBOARD_AUTOSTART=false: the dashboard is its own container
# in the compose topology, so the server must not also spawn it.
ENV CORTEX_MCP_TRANSPORT=http
ENV CORTEX_MCP_HOST=0.0.0.0
ENV CORTEX_MCP_PORT=3100
ENV CORTEX_API_HOST=0.0.0.0
ENV CORTEX_API_PORT=4141
ENV CORTEX_DASHBOARD_AUTOSTART=false
# resolveConfigPath uses os.homedir() (/root here) + .cortex, so the
# bind mount in docker-compose.yml handles workspace discovery — no
# extra env var needed.

# MCP HTTP + API ports. Both are intentionally behind a reverse proxy /
# Tailscale for remote deployments — do not expose to the open internet
# without an auth layer in front.
EXPOSE 3100 4141

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
