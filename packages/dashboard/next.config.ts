import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The dashboard is local-per-user. Rewrites let us proxy /api/cortex/* to
  // the cortex start sidecar without hard-coding its URL at build time.
  async rewrites() {
    const apiBase = process.env.CORTEX_API_URL ?? "http://127.0.0.1:4141";
    return [
      {
        source: "/api/cortex/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

export default config;
