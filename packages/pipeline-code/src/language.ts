/**
 * Extension → language label mapping. Covers the languages most code
 * adapters will see; anything not listed passes through as "plaintext".
 */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "markdown",
  rst: "restructuredtext",
  proto: "protobuf",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  tf: "hcl",
  hcl: "hcl",
  vue: "vue",
  svelte: "svelte",
  dart: "dart",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  lua: "lua",
  pl: "perl",
};

/** File-name patterns that override extension detection. */
const NAME_OVERRIDES: Array<[RegExp, string]> = [
  [/^dockerfile$/i, "dockerfile"],
  [/^makefile$/i, "makefile"],
  [/^\.?env(\.|$)/i, "dotenv"],
];

export function detectLanguage(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  for (const [pattern, lang] of NAME_OVERRIDES) {
    if (pattern.test(base)) return lang;
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? "plaintext";
}

/** True if the language is prose-shaped (markdown, rst, plain text). */
export function isProseLanguage(lang: string): boolean {
  return (
    lang === "markdown" ||
    lang === "restructuredtext" ||
    lang === "plaintext"
  );
}
