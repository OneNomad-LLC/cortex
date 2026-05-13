# syntax=docker/dockerfile:1.7
# Unified Cortex Cloud image. Runs the MCP server + dashboard in a
# single Node process via the server's auto-spawn of the dashboard
# child (CORTEX_DASHBOARD_AUTOSTART=true). Suitable for Fly Machines
# where one VM hosts everything for a single tenant.
#
# For docker-compose deploys where server and dashboard are separate
# containers, the per-package Dockerfiles under packages/*/Dockerfile
# still apply — this image is the single-process variant.
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
# `outputFileTracingIncludes` in dashboard's next.config.ts pulls
# `../../docs/**/*.md` into the standalone output for the /docs route.
COPY docs ./docs
COPY config ./config
COPY schemas ./schemas
RUN pnpm install --frozen-lockfile

# ── Stage 2: build the workspace + dashboard standalone bundle ──────
FROM deps AS build
WORKDIR /app
# `CORTEX_API_URL` is baked into the Next standalone output by the
# dashboard's next.config.ts rewrites(). Pin to localhost since the
# dashboard child runs in the same process tree as the API server.
ENV CORTEX_API_URL=http://127.0.0.1:4141
RUN pnpm -r run build

# ── Stage 3: runtime image ──────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# `git` powers `cortex module install <git-url>` from the dashboard's
# Modules page. `ca-certificates` is implicit in node:22-slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy the entire built workspace so the server's `resolveDashboardDir`
# walk can locate `packages/dashboard/.next/standalone/...` at runtime.
# The standalone bundle already contains its trimmed node_modules.
COPY --from=build /app /app
# Prune the server package + its runtime deps into a self-contained
# tree, then graft it back into the workspace under the same path so
# the dashboard-child resolver still finds packages/dashboard alongside.
RUN pnpm -r --prod deploy --filter=@onenomad/cortex /runtime-pkg \
    && rm -rf /app/packages/server/node_modules \
    && mv /runtime-pkg/node_modules /app/packages/server/node_modules

WORKDIR /app/packages/server

# Defaults for Fly Machines. Auth tokens are injected per-tenant by the
# pyre-web provisioner. The dashboard's autostart fires because both
# CORTEX_API_AUTH_TOKEN and CORTEX_MCP_AUTH_TOKEN gate the public
# surfaces — the local-host child needs no auth.
ENV CORTEX_MCP_TRANSPORT=http
ENV CORTEX_MCP_HOST=0.0.0.0
ENV CORTEX_MCP_PORT=3100
# CORTEX_API_ENABLED must be true for the dashboard API + the autostart
# of the dashboard child to fire. The committed cortex.yaml defaults
# `api.enabled` to false (operator-must-opt-in posture for laptop
# installs), so the production image flips it on via env.
ENV CORTEX_API_ENABLED=true
ENV CORTEX_API_HOST=0.0.0.0
ENV CORTEX_API_PORT=4141
ENV CORTEX_DASHBOARD_PORT=3030
ENV CORTEX_DASHBOARD_AUTOSTART=true

EXPOSE 3030 3100 4141

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
