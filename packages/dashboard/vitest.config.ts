import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest config for the dashboard SPA. Inherits the Vite plugin so
 * `.tsx` files compile, and points `@` at `src/` for parity with the
 * dev/build configs. `happy-dom` gives us window + DOM globals the
 * `api()` helper relies on without the weight of jsdom.
 *
 * `setupFiles` runs once before each test file — used to register
 * `@testing-library/react`'s `cleanup` so React 19 trees don't leak
 * across tests, and to install the `expect` extensions when we add
 * `@testing-library/jest-dom` later.
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
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    passWithNoTests: true,
  },
});
