# @onenomad/cortex-pipeline-code

Per-file code pipeline. Produces one memory per source file with
language detected from extension, size cap enforcement, and heuristic
chunking for large files.

Full tree-sitter chunking (semantic boundaries per-language) is
planned — this first cut splits on regex-detected top-level constructs
(functions, classes, `export` statements) and falls back to
character-window chunks.

Used by `@onenomad/cortex-adapter-bitbucket`, `@onenomad/cortex-adapter-github`, future
`@onenomad/cortex-adapter-gitlab`.

Adapter contract: the input `ClassifiedItem.content` is the raw file
body, `rawMetadata` carries `filePath`, `language`, `repo`, and other
repo-specific fields.
