/**
 * Tailwind CSS 4 ships its PostCSS integration as `@tailwindcss/postcss`.
 * Autoprefixer is still useful for cross-browser CSS that Tailwind
 * doesn't already cover (e.g. third-party libraries we drop in later).
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
