/**
 * Tailwind 4 derives most of its config from the CSS layer (see
 * `src/index.css`). This file mostly exists so editors/IDE
 * integrations and `@tailwindcss/postcss` can locate content roots
 * for class detection.
 *
 * @type {import("tailwindcss").Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};
