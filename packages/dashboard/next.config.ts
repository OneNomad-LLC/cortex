import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone output bundles the minimal runtime deps, so the Docker
  // image doesn't have to ship all of node_modules.
  output: "standalone",
  // Pull docs/*.md into the standalone output so the /docs route can
  // render them at request time. Without this, the trace skips them and
  // the dashboard 404s in Docker even though the source files exist in
  // the repo.
  outputFileTracingIncludes: {
    "/docs/**": ["../../docs/**/*.md"],
  },
  // Rewrites let us proxy /api/cortex/* to the cortex API without
  // hard-coding its URL at build time. Resolves at request time on the
  // Next server: inside docker compose this is http://cortex:4141; in
  // local dev (cortex start child), http://127.0.0.1:4141.
  async rewrites() {
    const apiBase = process.env.CORTEX_API_URL ?? "http://127.0.0.1:4141";
    return [
      {
        source: "/api/cortex/:path*",
        destination: `${apiBase}/api/:path*`,
      },
      // Admin endpoints — backup dump/restore, memory wipe/export.
      // pyre-web's server actions call these directly at
      // `/api/admin/*` against the Fly hostname; Fly :443 routes to
      // this dashboard (3030), so without the rewrite the dashboard
      // 404s before the API server ever sees the request. Auth is
      // checked on the API side via `X-Cortex-Gateway-Secret` or the
      // session cookie.
      {
        source: "/api/admin/:path*",
        destination: `${apiBase}/api/admin/:path*`,
      },
      // The cookie-handoff endpoint lives on the API server (it sets a
      // session cookie + 302s). User-facing traffic hits the dashboard
      // on :443; rewrite this prefix through to the API process so the
      // user's browser receives the Set-Cookie + Location response.
      {
        source: "/cortex-session/:path*",
        destination: `${apiBase}/cortex-session/:path*`,
      },
    ];
  },
};

export default config;
