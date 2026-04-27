# syntax=docker/dockerfile:1.7
# Multi-stage build for @onenomad/cortex-dashboard.
#
# Uses Next.js standalone output so the runtime image ships only the
# minimal server + node_modules needed to serve the dashboard. The
# monorepo install happens at the repo root so workspace links resolve.
#
# Build from the repo root:
#   docker build -f packages/dashboard/Dockerfile -t cortex-dashboard:latest .

FROM node:20-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Manifest-only pass so npm install is cacheable against package.json churn.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
# `outputFileTracingIncludes` in next.config.ts pulls `../../docs/**/*.md`
# into the standalone output so the /docs route can read them at runtime.
# That trace fails silently if the source files aren't in the build
# context — copy them in before the Next build runs.
COPY docs ./docs
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
# next.config.ts' rewrites() is evaluated at build time and the result
# is baked into the standalone server. The default compose topology
# always names the API service `cortex`, so hard-code that here;
# docker-compose's environment: block can still override at runtime
# for unusual topologies.
ENV CORTEX_API_URL=http://cortex:4141
RUN pnpm --filter @onenomad/cortex-dashboard build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3030
ENV HOSTNAME=0.0.0.0
ENV CORTEX_API_URL=http://cortex:4141

# Next's standalone output ships a trimmed node_modules + server.js.
# /public and /.next/static are served directly by the standalone server.
COPY --from=build /app/packages/dashboard/.next/standalone ./
COPY --from=build /app/packages/dashboard/.next/static ./packages/dashboard/.next/static
# No /public dir in this project — skip copying it. If one is added later,
# the COPY would go here.

EXPOSE 3030

# Standalone output places server.js under the package's workspace path.
CMD ["node", "packages/dashboard/server.js"]
