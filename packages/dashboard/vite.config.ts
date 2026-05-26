import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Cortex dashboard SPA.
 *
 * Served by the Cortex HTTP sidecar at `/_dashboard/*` — see the
 * `dashboard-assets` route in `packages/server/src/api/routes/`.
 * Hashing the asset filenames lets us send `Cache-Control: immutable`
 * for everything under `/_dashboard/assets/*` while `index.html` itself
 * stays `no-cache` so a fresh build is picked up on the next reload.
 */
export default defineConfig({
  base: "/_dashboard/",
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig path alias so imports like
      // `@/components/ui/card` resolve in both Vite and tsc.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
