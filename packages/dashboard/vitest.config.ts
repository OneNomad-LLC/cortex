import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config for the dashboard SPA. Inherits the Vite plugin so
 * `.tsx` files compile, and points `@` at `src/` for parity with the
 * dev/build configs. `happy-dom` gives us window + DOM globals the
 * `api()` helper relies on without the weight of jsdom.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
  },
});
