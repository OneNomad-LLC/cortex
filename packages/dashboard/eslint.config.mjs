// Dashboard package ESLint flat config. Inherits the workspace root
// rules and layers Next 15 / React-specific config on top via the
// `eslint-config-next` flat-config compat shim. Required because the
// dashboard pulls in JSX, React hooks, and Next-aware lint rules that
// don't apply to the rest of the Node monorepo.
//
// Why this lives here instead of merging into the root: the workspace
// root config is shared by ~30 Node packages. Adding next/react rules
// at the root would slow lint runs and force Next-version coupling
// across every package; keeping it scoped here keeps blast radius
// minimal.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";
import rootConfig from "../../eslint.config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  ...rootConfig,
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "next-env.d.ts"],
  },
];

export default config;
