// Cortex monorepo ESLint flat config (ESLint 9). Single root config
// covers every package's `lint` script (`eslint src`). Per-package
// overrides can be added later if a package grows distinct rules; for
// now the rule set is uniform across the workspace.
//
// Picked typescript-eslint's `recommended` over `recommended-type-checked`
// because the latter requires a tsconfig wired up to the resolver and
// adds noticeable lint latency across 33 packages. The base recommended
// config catches the things we care about (no-unused, no-any, etc.)
// without forcing cross-package type-info plumbing.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      // Underscore-prefixed args/vars are a documented intent-to-not-use
      // signal across the repo (matching synapse + onenomad conventions).
      // Warn rather than error so existing code that picked up a few
      // dead-arg/dead-var lines over time doesn't gate CI green on this
      // PR. Matches the sibling `onenomad` repo style. Tighten in a
      // follow-up sweep when ready.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^(_|err|error|ignore)",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The codebase has a few legitimate `any` shapes at boundary code
      // (third-party MCP SDK types, cross-package adapters). Warn rather
      // than error so we surface them without breaking CI on existing
      // code; tighten in a follow-up sweep when ready.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      // Next 15 / dashboard package is React; the no-redeclare rule
      // chokes on namespace merging patterns. Off at the workspace root;
      // dashboard can re-enable selectively if needed.
      "no-redeclare": "off",
    },
  },
  {
    // Tests are allowed to be looser — `any` for fixtures, no-floating
    // expressions are common in vitest assertion chains.
    files: ["**/tests/**/*.{ts,tsx,mts,mjs}", "**/*.test.{ts,tsx,mts,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
