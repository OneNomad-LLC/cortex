# Cortex one-shot installer for Windows.
#
# Usage:
#   irm https://install.cortex.onenomad.dev/ps1 | iex
#   & ([scriptblock]::Create((irm https://install.cortex.onenomad.dev/ps1))) -Dir C:\cortex -Yes
#
# What it does:
#   1. Verify prerequisites (git, node>=22, pnpm).
#   2. Clone https://github.com/OneNomad-LLC/cortex into the chosen directory.
#   3. pnpm install + pnpm -r build.
#   4. Write a zero-config cortex.yaml using the engram backend
#      (local Xenova embeddings -- no LLM provider, no Docker).
#   5. Print MCP-client wire-up instructions.
#
# Companion to scripts/install.sh -- same end-state on both platforms.
# When piping through iex, pass arguments via the scriptblock pattern
# above (PowerShell can't do `bash -s --` -style positional args
# through stdin alone).
#
# Exits non-zero on any failure with a concrete next-step message.

[CmdletBinding()]
param(
    [string] $Dir,
    [switch] $Yes,
    [switch] $SkipBuild,
    [switch] $Help
)

$ErrorActionPreference = 'Stop'
$CortexRepo = if ($env:CORTEX_REPO) { $env:CORTEX_REPO } else { 'https://github.com/OneNomad-LLC/cortex.git' }
$DefaultDir = Join-Path $env:USERPROFILE '.cortex-install'
if (-not $Dir) { $Dir = $DefaultDir }

function Show-Header($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Show-Ok($text)     { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Show-Warn($text)   { Write-Host "  [WARN] $text" -ForegroundColor Yellow }
function Show-Err($text)    { Write-Host "  [FAIL] $text" -ForegroundColor Red }
function Show-Line($text)   { Write-Host "  $text" }

function Show-Usage {
    Write-Host @"
Cortex installer (Windows)

Usage: install.ps1 [options]

Options:
  -Dir PATH         Install into PATH (default: $DefaultDir)
  -Yes              Non-interactive: never prompt, accept defaults
  -SkipBuild        Clone + install deps but skip the build step
  -Help             Print this help

Environment:
  CORTEX_REPO       Override the source git URL (default: $CortexRepo)

Examples:
  irm https://install.cortex.onenomad.dev/ps1 | iex
  & ([scriptblock]::Create((irm https://install.cortex.onenomad.dev/ps1))) -Dir C:\cortex -Yes
"@
}

if ($Help) { Show-Usage; exit 0 }

# Confirm with the user, or auto-yes when -Yes was passed. Non-
# interactive sessions (piped through iex) skip prompts because
# Read-Host on a non-tty hangs forever.
function Confirm-Action([string]$question, [bool]$useDefault = $true) {
    if ($Yes) { return $true }
    if (-not [Environment]::UserInteractive) { return $true }
    $hint = if ($useDefault) { '[Y/n]' } else { '[y/N]' }
    $reply = Read-Host -Prompt ($question + ' ' + $hint)
    if ([string]::IsNullOrWhiteSpace($reply)) { return $useDefault }
    return ($reply -match '^(y|yes)$')
}

function Test-Bin($bin, $hint) {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        Show-Err "$bin not found on PATH"
        Show-Line "install with: $hint"
        return $false
    }
    return $true
}

# Node 22+ check. We only care about major; the patch level doesn't gate
# anything Cortex uses.
function Test-NodeVersion {
    try {
        $raw = (& node --version).Trim().TrimStart('v')
        $major = [int]($raw -split '\.')[0]
        if ($major -ge 22) {
            Show-Ok "node $raw"
            return $true
        }
        Show-Err "node $raw found, need >= 22.0"
        Show-Line "upgrade via: nvm install 22  (or your package manager)"
        return $false
    } catch {
        Show-Err "node not found on PATH"
        Show-Line "install via: nvm install 22  (https://github.com/coreybutler/nvm-windows)"
        return $false
    }
}

# Try corepack first when pnpm isn't on PATH -- Node 22 ships with corepack
# and Cortex's package.json packageManager field tells corepack which pnpm
# version to fetch automatically.
function Enable-PnpmViaCorepack {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { return }
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Show-Line "pnpm not on PATH -- enabling via corepack"
        & corepack enable pnpm 2>&1 | Out-Null
    }
}

function Step-Preflight {
    Show-Header "1/5 Prerequisites"
    $ok = $true
    if (-not (Test-Bin 'git'  'https://git-scm.com/downloads or winget install Git.Git')) { $ok = $false }
    if (-not (Test-NodeVersion))                                                          { $ok = $false }
    Enable-PnpmViaCorepack
    if (-not (Test-Bin 'pnpm' 'corepack enable pnpm  (Node 22+ ships with corepack)  or: npm install -g pnpm')) { $ok = $false }
    if (-not $ok) { Show-Err "fix the missing prerequisites above and re-run"; exit 1 }
    Show-Ok "git + node + pnpm OK"
}

function Step-InstallDir {
    Show-Header "2/5 Install location"
    Show-Line "target: $Dir"
    if (Test-Path $Dir) {
        $entries = Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue
        if ($null -eq $entries -or $entries.Count -eq 0) {
            Show-Ok "directory exists and is empty -- using it"
            return
        }
        Show-Err "$Dir already exists and is not empty"
        Show-Line "pick a different path with -Dir, or delete it and re-run"
        exit 1
    }
    $parent = Split-Path -Parent $Dir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Show-Ok "will create $Dir"
}

function Step-Clone {
    Show-Header "3/5 Clone"
    Show-Line "$CortexRepo -> $Dir"
    & git clone --depth=1 $CortexRepo $Dir
    if ($LASTEXITCODE -ne 0) { Show-Err "git clone failed (exit $LASTEXITCODE)"; exit 1 }
    Show-Ok "cloned"
}

function Step-Build {
    Show-Header "4/5 Install + build"
    Push-Location $Dir
    try {
        if ($SkipBuild) {
            Show-Warn "skipping build (-SkipBuild); run 'pnpm -r build' later"
            & pnpm install --prefer-offline
            if ($LASTEXITCODE -ne 0) { Show-Err "pnpm install failed (exit $LASTEXITCODE)"; exit 1 }
            Show-Ok "deps installed"
            return
        }
        & pnpm install --prefer-offline
        if ($LASTEXITCODE -ne 0) { Show-Err "pnpm install failed (exit $LASTEXITCODE)"; exit 1 }
        & pnpm -r build
        if ($LASTEXITCODE -ne 0) { Show-Err "pnpm -r build failed (exit $LASTEXITCODE)"; exit 1 }
        Show-Ok "deps + build OK"
    } finally { Pop-Location }
}

# Write a zero-config cortex.yaml. MUST match what install.sh produces
# so both platforms land at the same end-state. Uses the engram backend
# (local Xenova embeddings, no LLM provider needed) because pgvector
# currently requires an enabled LLM provider for embeddings.
function Write-EmbeddedConfig {
    $configDir = Join-Path $Dir 'config'
    $configPath = Join-Path $configDir 'cortex.yaml'
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    $pgliteDir = Join-Path $Dir 'data\pglite'
    $yaml = @"
# Auto-generated by the Cortex one-shot installer (install.ps1).
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
    dataDir: $pgliteDir
    table: cortex_memories
    embeddingDim: 384

llm:
  providers:
    openrouter:
      package: "@onenomad/cortex-provider-openrouter"
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
"@
    # UTF-8 without BOM -- Cortex's YAML parser doesn't tolerate the
    # BOM PowerShell defaults to with Out-File.
    [System.IO.File]::WriteAllText($configPath, $yaml, (New-Object System.Text.UTF8Encoding $false))
    Show-Line "wrote $configPath"
}

function Step-Config {
    Show-Header "5/5 Config"
    $configPath = Join-Path $Dir 'config\cortex.yaml'
    if (Test-Path $configPath) {
        Show-Warn "config\cortex.yaml already exists -- leaving it alone"
    } else {
        Write-EmbeddedConfig
    }
    Show-Ok "config ready"
}

function Show-NextSteps {
    $serverEntry = Join-Path $Dir 'packages\server\dist\index.js'
    Show-Header "Next steps"
    Write-Host @"

  Cortex is installed at: $Dir

  > Run the MCP server directly:
      node "$serverEntry" start

  > Wire into Claude Desktop / Code (claude_desktop_config.json):
      {
        "mcpServers": {
          "cortex": {
            "command": "node",
            "args": ["$($serverEntry -replace '\\','\\\\')", "start"]
          }
        }
      }

  > Wire into Pyre:
      Settings → Agents → MCP Servers → Add. Use the same command/args
      as above, with id 'cortex' and CORTEX_CONFIG_PATH pointing at
      $($Dir)\config\cortex.yaml in the env block.

  > Add a data source:
      cd "$Dir"; pnpm cortex add notion   (or github/slack/...)

  > Ingest a doc / URL / repo via the dashboard or your MCP client.

  Docs: $($CortexRepo -replace '\.git$','')#readme
"@
}

function Main {
    Show-Header "Cortex installer (Windows)"
    Show-Line "repo:    $CortexRepo"
    Show-Line "dir:     $Dir"
    Step-Preflight
    Step-InstallDir
    Step-Clone
    Step-Build
    Step-Config
    Show-NextSteps
}

Main
