# @onenomad/przm-cortex-pipeline-code-dossier

Code dossier pipeline. Runs a 3-pass LLM-driven architectural
extraction over a checked-out repo and emits a small number of
high-signal memories — a `brief`-typed architectural dossier plus
one `decision` per ADR and one `reference` per significant entry
point.

This is a deliberate alternative to `@onenomad/przm-cortex-pipeline-code`,
which walks every file and emits hundreds of low-signal chunks
suitable for code search. The two pipelines coexist; callers
(MCP tools, adapters) choose between them via a `mode` parameter.

## Why it exists

A team using Cortex to "remember a repo" doesn't usually want code
search — they want to know what the repo IS. The dossier pipeline
captures architecture, key modules, design decisions, and tech
stack at the level a new teammate would summarize them on a wiki
page. The output reads like a hand-written architectural overview
because that's what the synthesis prompt asks for.

## Output shape

Each `run()` invocation produces a `PipelineMemory[]`:

| Type        | Count                   | Content                                           |
| ----------- | ----------------------- | ------------------------------------------------- |
| `brief`     | 1                       | The synthesized architectural dossier (markdown). |
| `decision`  | one per `docs/ADR-*.md` | The ADR file verbatim.                            |
| `reference` | one per entry point     | The entry point file verbatim.                    |

When `ctx.llm` is not available, the pipeline gracefully degrades
to a single `brief` memory containing the raw structural payload
(no synthesis). The caller can still re-run later under a configured
LLM to upgrade quality.

## Inputs

```ts
import type { CodeDossierInput } from "@onenomad/przm-cortex-pipeline-code-dossier";

const input: CodeDossierInput = {
  repoPath: "/abs/path/to/checkout",
  sourceIdPrefix: "github:OneNomad-LLC/cortex",
  project: "cortex",            // optional
  tags: ["dossier"],             // optional
  sourceUrl: "https://github.com/OneNomad-LLC/cortex", // optional
};
```

## Re-derivation gating

`computeInputsSha(input)` returns a stable SHA-256 over the
structural payload (sorted file paths + content hashes). Callers
use it to decide whether to re-run synthesis; the pipeline itself
always runs when invoked.

## Prompts

Prompts live as markdown files in `src/prompts/`. Per ADR-007 they
are never inlined in code — review and tuning happen in the .md
files alongside the implementation.
