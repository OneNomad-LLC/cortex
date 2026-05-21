#!/usr/bin/env bash
# Cortex one-shot installer.
#
# Usage:
#   curl -fsSL https://install.cortex.onenomad.dev | bash
#   curl -fsSL https://install.cortex.onenomad.dev | bash -s -- --dir ~/cortex
#
# What it does:
#   1. Verify prerequisites (git, node>=22, pnpm).
#   2. Clone https://github.com/OneNomad-LLC/przm-cortex into the chosen directory.
#   3. pnpm install + pnpm -r build.
#   4. Write a zero-config cortex.yaml using the embedded PGlite backend
#      (no Docker, no system Postgres needed).
#   5. Print MCP-client wire-up instructions for Claude Desktop / Pyre /
#      Claude Code.
#
# Same end-state as the in-app "Install Cortex" button in Pyre — both
# paths land here so users get a consistent install regardless of
# whether they came in through the GUI or the terminal.
#
# Exits non-zero on any failure with a concrete next-step message.

set -euo pipefail

PRZM_CORTEX_REPO="${PRZM_CORTEX_REPO:-https://github.com/OneNomad-LLC/przm-cortex.git}"
DEFAULT_DIR="${HOME}/.cortex-install"
INSTALL_DIR="${DEFAULT_DIR}"
NON_INTERACTIVE=0
SKIP_BUILD=0
NO_COLOR=0

# Color helpers — guarded so we degrade gracefully when piped through
# non-tty consumers (CI logs, etc.).
if [ -t 1 ] && [ "${NO_COLOR}" -eq 0 ] && [ -z "${NO_COLOR_ENV:-}" ]; then
  C_DIM="\033[2m"; C_BOLD="\033[1m"
  C_RED="\033[31m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"; C_BLUE="\033[34m"
  C_RESET="\033[0m"
else
  C_DIM=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

log()  { printf "%b%s%b\n" "${C_BLUE}" "$*" "${C_RESET}"; }
ok()   { printf "%b✓ %s%b\n" "${C_GREEN}" "$*" "${C_RESET}"; }
warn() { printf "%b⚠ %s%b\n" "${C_YELLOW}" "$*" "${C_RESET}" >&2; }
err()  { printf "%b✗ %s%b\n" "${C_RED}" "$*" "${C_RESET}" >&2; }
hdr()  { printf "\n%b%s%b\n" "${C_BOLD}" "$*" "${C_RESET}"; }

usage() {
  cat <<EOF
Cortex installer

Usage: install.sh [options]

Options:
  --dir PATH        Install into PATH (default: ${DEFAULT_DIR})
  --yes, -y         Non-interactive: never prompt, accept defaults
  --skip-build      Clone + install deps but skip the build step
  --help, -h        Print this help

Environment:
  PRZM_CORTEX_REPO       Override the source git URL (default: ${PRZM_CORTEX_REPO})
  NO_COLOR_ENV=1    Disable color output

Examples:
  curl -fsSL https://install.cortex.onenomad.dev | bash
  curl -fsSL https://install.cortex.onenomad.dev | bash -s -- --dir ~/cortex --yes
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)        INSTALL_DIR="${2:?--dir needs a value}"; shift 2;;
      --dir=*)      INSTALL_DIR="${1#--dir=}"; shift;;
      --yes|-y)     NON_INTERACTIVE=1; shift;;
      --skip-build) SKIP_BUILD=1; shift;;
      --help|-h)    usage; exit 0;;
      *) err "unknown option: $1"; usage >&2; exit 2;;
    esac
  done
}

# Confirm with the user, or auto-yes when --yes was passed. When stdin
# isn't a tty (the canonical curl|bash case), prompts are skipped — we
# can't read input from a closed pipe. Caller is responsible for
# passing --dir / --yes when piping.
confirm() {
  local prompt="$1" default="${2:-y}"
  if [ "${NON_INTERACTIVE}" -eq 1 ] || [ ! -t 0 ]; then
    return 0
  fi
  local hint
  if [ "${default}" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf "%s %s " "${prompt}" "${hint}"
  local reply; read -r reply
  reply="${reply:-${default}}"
  case "${reply}" in [yY]|[yY][eE][sS]) return 0;; *) return 1;; esac
}

# Compare semver triples; returns 0 when $1 >= $2. We only care about
# major/minor for the node check (the patch level doesn't gate anything
# Cortex uses).
ver_ge() {
  local have="$1" want="$2"
  local have_major="${have%%.*}"
  local want_major="${want%%.*}"
  if [ "${have_major}" -gt "${want_major}" ]; then return 0; fi
  if [ "${have_major}" -lt "${want_major}" ]; then return 1; fi
  local have_minor="${have#*.}"; have_minor="${have_minor%%.*}"
  local want_minor="${want#*.}"; want_minor="${want_minor%%.*}"
  [ "${have_minor:-0}" -ge "${want_minor:-0}" ]
}

require_bin() {
  local bin="$1" install_hint="$2"
  if ! command -v "${bin}" >/dev/null 2>&1; then
    err "${bin} not found on PATH"
    printf "  install with: %s\n" "${install_hint}" >&2
    return 1
  fi
}

step_preflight() {
  hdr "1/5 Prerequisites"
  local ok=1
  require_bin git "https://git-scm.com/downloads (or your package manager)" || ok=0

  if command -v node >/dev/null 2>&1; then
    local node_ver; node_ver="$(node --version)"; node_ver="${node_ver#v}"
    if ver_ge "${node_ver}" "22.0"; then
      ok "node ${node_ver}"
    else
      err "node ${node_ver} found, need >= 22.0"
      printf "  upgrade via: nvm install 22  (or your package manager)\n" >&2
      ok=0
    fi
  else
    err "node not found on PATH"
    printf "  install via: nvm install 22  (https://nvm.sh)\n" >&2
    ok=0
  fi

  # Try corepack first when pnpm isn't on PATH — Node 22 ships with corepack,
  # and Cortex's package.json packageManager field tells corepack which pnpm
  # to fetch automatically. Falls through to a hard error only when corepack
  # itself is unavailable (uncommon on Node 22+).
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      log "  pnpm not on PATH — enabling via corepack"
      corepack enable pnpm >/dev/null 2>&1 || true
    fi
  fi
  require_bin pnpm "corepack enable pnpm  (Node 22+ ships with corepack)  or: npm install -g pnpm" || ok=0

  [ "${ok}" -eq 1 ] || { err "fix the missing prerequisites above and re-run"; exit 1; }
  ok "git + node + pnpm OK"
}

step_install_dir() {
  hdr "2/5 Install location"
  log "  target: ${INSTALL_DIR}"
  if [ -e "${INSTALL_DIR}" ]; then
    if [ -d "${INSTALL_DIR}" ] && [ -z "$(ls -A "${INSTALL_DIR}" 2>/dev/null)" ]; then
      ok "directory exists and is empty — using it"
      return 0
    fi
    err "${INSTALL_DIR} already exists and is not empty"
    printf "  pick a different path with --dir, or delete it and re-run\n" >&2
    exit 1
  fi
  mkdir -p "$(dirname "${INSTALL_DIR}")"
  ok "will create ${INSTALL_DIR}"
}

step_clone() {
  hdr "3/5 Clone"
  log "  ${PRZM_CORTEX_REPO} → ${INSTALL_DIR}"
  # Roll back a partial clone if git fails mid-fetch; otherwise the next
  # run trips step_install_dir's "exists and not empty" guard with no
  # easy way to tell what went wrong.
  if ! git clone --depth=1 "${PRZM_CORTEX_REPO}" "${INSTALL_DIR}"; then
    err "git clone failed; rolling back ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}" 2>/dev/null || true
    exit 1
  fi
  ok "cloned"
}

step_build() {
  hdr "4/5 Install + build"
  if [ "${SKIP_BUILD}" -eq 1 ]; then
    warn "skipping build (--skip-build); you'll need to run \`pnpm -r build\` later"
    pnpm --dir "${INSTALL_DIR}" install --prefer-offline
    ok "deps installed"
    return 0
  fi
  pnpm --dir "${INSTALL_DIR}" install --prefer-offline
  pnpm --dir "${INSTALL_DIR}" -r build
  ok "deps + build OK"
}

# Write a zero-config cortex.yaml. Uses the engram backend (local
# Xenova embeddings, no LLM provider needed) because the pgvector
# backend currently requires an enabled LLM provider for embeddings,
# which defeats the zero-config goal. llm.providers + llm.tasks are
# stubbed (openrouter disabled) to satisfy the schema; pure ingestion
# + kb_search work without an active LLM provider.
write_embedded_config() {
  local config_dir="${INSTALL_DIR}/config"
  local config_path="${config_dir}/cortex.yaml"
  mkdir -p "${config_dir}"
  local pglite_dir="${INSTALL_DIR}/data/pglite"
  cat > "${config_path}" <<EOF_CORTEX_YAML
# Auto-generated by the Cortex one-shot installer.
# Zero-config: pgvector backend with embedded PGlite (in-process
# Postgres + pgvector) and Cortex's internal Xenova embedder
# (MiniLM-L6-v2, 384-dim, ~23MB downloaded on first run). No LLM
# provider, no Docker, no system Postgres, no external memory dep.
#
# llm.providers + llm.tasks are stubbed (openrouter disabled) to
# satisfy the schema. Pure ingestion + kb_search work without an
# active LLM. To enable LLM enrichment (summarization, classification),
# set OPENROUTER_API_KEY and flip enabled: true below.
#
# To use external Postgres instead of PGlite, set
#   memory.pgvector.mode: external
#   memory.pgvector.connectionString: "postgres://..."
#
# Add adapters with: cortex add <id>   (e.g. notion, github, slack)

memory:
  primary: pgvector
  pgvector:
    mode: embedded
    dataDir: ${pglite_dir}
    table: cortex_memories
    embeddingDim: 384

llm:
  providers:
    openrouter:
      package: "@onenomad/przm-cortex-provider-openrouter"
      enabled: false
      config:
        appTitle: "Cortex"
  # Cortex's LLM is used for ingest-time enrichment ONLY (brief,
  # classify, structural). Query-time synthesis happens on the Pyre
  # client using its local LLM. See Pyre Business Plan §16.
  tasks:
    default:    { provider: openrouter, model: "google/gemini-2.5-flash-lite" }
    brief:      { provider: openrouter, model: "google/gemini-2.5-flash-lite" }
    classify:   { provider: openrouter, model: "google/gemini-2.5-flash-lite" }
    structural: { provider: openrouter, model: "mistralai/mistral-small-3.2" }
  fallbackChain: ["meta-llama/llama-3.1-8b-instruct"]

adapters: {}
EOF_CORTEX_YAML
  printf "  wrote %s\n" "${config_path}"
}

step_config() {
  hdr "5/5 Config"
  if [ -f "${INSTALL_DIR}/config/cortex.yaml" ]; then
    warn "config/cortex.yaml already exists — leaving it alone"
  else
    write_embedded_config
  fi
  ok "config ready"
}

print_next_steps() {
  local server_entry="${INSTALL_DIR}/packages/server/dist/index.js"
  hdr "Next steps"
  cat <<EOF

  Cortex is installed at: ${INSTALL_DIR}

  ▸ Run the MCP server directly:
      node "${server_entry}" start

  ▸ Wire into Claude Desktop / Code (~/.../claude_desktop_config.json):
      {
        "mcpServers": {
          "cortex": {
            "command": "node",
            "args": ["${server_entry}", "start"]
          }
        }
      }

  ▸ Wire into Pyre:
      Already integrated — Pyre auto-registers Cortex via its
      "Install Cortex" button. If you're installing this way, point
      Pyre's MCP entry at the server entry above.

  ▸ Add a data source:
      cd "${INSTALL_DIR}" && pnpm cortex add notion   (or github/slack/...)

  ▸ Ingest a doc / URL / repo via the dashboard or Pyre's Knowledge card.

  Docs: ${PRZM_CORTEX_REPO%.git}#readme
EOF
}

main() {
  parse_args "$@"
  hdr "Cortex installer"
  log "  repo:    ${PRZM_CORTEX_REPO}"
  log "  dir:     ${INSTALL_DIR}"
  step_preflight
  step_install_dir
  step_clone
  step_build
  step_config
  print_next_steps
}

main "$@"
