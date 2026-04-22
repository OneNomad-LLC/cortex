# syntax=docker/dockerfile:1.7
# Multi-stage build for @onenomad/cortex.
#
# Stage 1 (deps): install full workspace with pnpm. We build from the
#   monorepo root so the workspace links (@cortex/*) resolve.
# Stage 2 (build): run tsc --build across the workspace.
# Stage 3 (runtime): copy compiled dist + pruned prod node_modules into
#   a clean image. Exposes 4040 (webhook receiver) and 3100 (optional HTTP
#   MCP transport — unused when CORTEX_MCP_TRANSPORT=stdio, which is the
#   default).
#
# Build from the repo root:
#   docker build -f packages/server/Dockerfile -t cortex:latest .

FROM node:20-alpine AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy workspace manifest + all package manifests for an install-only pass.
# This is cached until any package.json changes — subsequent source edits
# skip the heavy install step.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
RUN pnpm -r run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy everything from the build stage. We prune dev deps as a separate
# step so pnpm can walk the workspace graph correctly.
COPY --from=build /app /app
RUN pnpm -r --prod deploy --filter=@onenomad/cortex /runtime-pkg
# Drop the raw workspace — /runtime-pkg is the self-contained deploy.

WORKDIR /runtime-pkg

# Default config path. Mount `./config` from the host (or a volume) here.
ENV CORTEX_CONFIG_PATH=/config/cortex.yaml
ENV CORTEX_MCP_TRANSPORT=stdio

# Webhook receiver (when enabled in cortex.yaml). Optional HTTP MCP
# transport on 3100 when CORTEX_MCP_TRANSPORT=http.
EXPOSE 4040 3100

ENTRYPOINT ["node", "dist/index.js"]
CMD ["start"]
