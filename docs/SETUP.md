# Setup

Manual steps before Claude Code can usefully start building.

Cortex targets **Windows, macOS, and Linux**. Install commands below show
each variant; pick your OS. Runtime commands (`pnpm ...`, `cortex ...`,
`docker compose ...`) work identically on all three.

## Reference hardware split

Cortex development and runtime can span machines. The author's setup, for
reference — yours will differ:

| Machine | Role | OS |
|---------|------|-----|
| Primary dev machine | Where you write code + run Claude Code | Windows / macOS / Linux |
| Secondary Ollama host (optional) | Fallback LLM if primary is off | macOS or Linux |
| VPS | Always-on host for Cortex/Engram/Persona MCPs (optional — local-only setups skip this) | Linux (Ubuntu 24.04 reference) |

Individual users can run everything on one machine. Teams typically put the
shared services on a single VPS and have each dev run a personal Cortex
daemon locally. See [HOSTING.md](HOSTING.md).

## Progress Tracker

Check items off as you complete them. This is the authoritative status of
setup work.

### Done

- [x] Ollama installed on Windows with GPU acceleration (9070 XT)
- [x] Tailscale installed on Windows and Mac (Personal free tier)
- [x] Qwen 3 14B pulled and verified running on GPU

### Remaining

- [ ] Pick a name (currently "Cortex" placeholder)
- [ ] Windows: install Node 20+, Git, VS Code, Docker Desktop, Claude Code, pnpm
- [ ] Private GitHub repo created and cloned to Windows
- [ ] Starter docs committed to repo (CLAUDE.md, README.md, docs/)
- [ ] Engram cloned locally and verified running on Windows
- [ ] Persona cloned locally and verified running on Windows
- [ ] `config/projects.yaml` written with 2-5 real projects
- [ ] `config/people.yaml` written with 3-10 people
- [ ] Loom API key generated
- [ ] Atlassian API token generated
- [ ] OpenRouter account created and API key generated
- [ ] `.env.example` committed, `.env` created locally (gitignored)
- [ ] Verified Ollama reachable from Mac via Tailscale hostname

### Deferred (until later phases)

- Mac Ollama as secondary (set up when Phase 3 needs synthesis fallback)
- Obsidian vault structure (Phase 9)
- Google Calendar credentials (Phase 6)
- Bitbucket credentials (Phase 10)
- VPS provisioning (Phase 4-5; see HOSTING.md)

## Remaining Steps

### 1. Pick a name

Currently `Cortex` as a placeholder. Replace throughout the repo once chosen.
Search-and-replace: `Cortex` -> your name, `cortex` -> lower slug version.

### 2. Install development tools

Pick your OS. All three paths end at the same set of tools: Node 20+,
pnpm, Git, Docker (optional), Claude Code.

**Windows (PowerShell):**

```powershell
# Node 20+ via fnm (recommended) or installer from nodejs.org
winget install Schniz.fnm
fnm install 20
fnm use 20
node -v

# pnpm
npm install -g pnpm
pnpm -v

# Git — bundles Git Bash, which git uses to run hooks
winget install --id Git.Git

# Line endings (critical for cross-OS contributor work)
git config --global core.autocrlf input

# VS Code (optional)
winget install --id Microsoft.VisualStudioCode

# Docker Desktop (only needed if you plan to run docker compose)
winget install --id Docker.DockerDesktop

# Claude Code — install from https://claude.ai/download
```

**macOS (zsh/bash, Homebrew):**

```bash
# Homebrew if you don't have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node 20+
brew install node@20
brew link --force --overwrite node@20
node -v

# pnpm
npm install -g pnpm
pnpm -v

# Git
brew install git
git config --global core.autocrlf input

# VS Code (optional)
brew install --cask visual-studio-code

# Docker Desktop (only needed for docker compose)
brew install --cask docker

# Claude Code — install from https://claude.ai/download
```

**Linux (bash, Debian/Ubuntu shown; adapt for Arch/Fedora):**

```bash
# Node 20+ via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node -v

# pnpm
npm install -g pnpm
pnpm -v

# Git
sudo apt update && sudo apt install -y git
git config --global core.autocrlf input

# Docker (optional; only for compose deployments)
sudo apt install -y docker.io docker-compose-plugin
sudo usermod -aG docker $USER    # log out / back in for group change

# Claude Code — install from https://claude.ai/download
```

Why pnpm: npm workspaces work but pnpm is faster and handles the monorepo
pattern (many packages, deduplicated dependencies) noticeably better. Yarn
also works; pick pnpm unless you have an existing preference.

### 3. Create the repo

Private GitHub repo, initialized empty. Clone it:

**Windows (PowerShell):**

```powershell
Set-Location C:\Users\<you>\code
git clone <your-cortex-repo-url>
Set-Location cortex
```

**macOS / Linux:**

```bash
cd ~/code
git clone <your-cortex-repo-url>
cd cortex
```

Drop in the starter docs (CLAUDE.md, README.md, docs/ARCHITECTURE.md,
docs/ROADMAP.md, docs/DECISIONS.md, docs/SETUP.md, docs/HOSTING.md) as your
first commit: "Initial docs and architecture."

### 4. Clone Engram and Persona locally

Keep them as separate directories next to Cortex. They'll be run as services
during dev, consumed over MCP.

**Windows (PowerShell):**

```powershell
Set-Location ..
git clone <your-engram-repo-url>
Set-Location engram
pnpm install
pnpm run build

Set-Location ..
git clone <your-persona-repo-url>
Set-Location persona
pnpm install
pnpm run build
```

**macOS / Linux:**

```bash
cd ..
git clone <your-engram-repo-url>
cd engram
pnpm install
pnpm run build

cd ..
git clone <your-persona-repo-url>
cd persona
pnpm install
pnpm run build
```

Verify both start successfully. Note the MCP ports/endpoints they use. Phase 1
will configure Cortex to talk to them.

### 5. Verify Ollama is reachable

Skip if you haven't set up a remote Ollama host. If you have: test from any
machine that isn't the Ollama host.

**macOS / Linux:**

```bash
curl http://<ollama-host>:11434/api/tags
```

**Windows (PowerShell):**

```powershell
Invoke-RestMethod http://<ollama-host>:11434/api/tags
```

Should return a JSON list of installed models including the one you pulled
(e.g., `qwen3:14b`). Do NOT skip this. If it fails, fix the host/binding
before proceeding — every later step depends on this working.

Also test actual inference speed (first call is slower due to model load):

**macOS / Linux:**

```bash
time curl -X POST http://<ollama-host>:11434/api/generate \
  -d '{"model":"qwen3:14b","prompt":"Say hello","stream":false}'
```

**Windows (PowerShell):**

```powershell
Measure-Command {
  Invoke-RestMethod -Method POST -Uri http://<ollama-host>:11434/api/generate `
    -Body '{"model":"qwen3:14b","prompt":"Say hello","stream":false}'
}
```

Second call should be under 3 seconds. If it's 30+ seconds on a warm model,
check Tailscale admin console: connection should be "direct," not "relayed."

### 6. Gather source credentials

**Loom** (needed by Phase 4):
1. Sign into Loom, verify your plan supports API access
2. Generate API key from account settings
3. Note: Loom's API is tier-gated; verify access now before planning around it

**Atlassian** (needed by Phase 5 Confluence):
1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
2. Create a new API token, save it securely (you can't see it again)
3. Note your workspace URL (e.g., `yourcompany.atlassian.net`)
4. Note your email (used as API auth username)

**OpenRouter** (needed from Phase 3 onward for synthesis fallback):
1. Sign up at openrouter.ai
2. Add a small amount of credit ($5-10 is plenty to start)
3. Generate an API key

Skip these for later phases:
- Google Calendar (Phase 6)
- Bitbucket (Phase 10)
- Obsidian (Phase 9, no content yet anyway)

### 7. Write initial `config/projects.yaml`

Critical and only you can write this. Claude Code uses it for classification,
filtering, and `get_project_context`. Create in the repo.

Template:

```yaml
projects:
  - slug: project-alpha
    name: "Project Alpha (full name)"
    description: "One-sentence description of what this project is."
    active: true
    aliases: ["Alpha", "Proj A"]   # variants used in meetings/docs
    people: [matt, sarah]           # slugs from people.yaml
    sources:
      confluence_space: "ALPHA"
      bitbucket_repos: ["alpha-backend", "alpha-frontend"]

  - slug: project-beta
    ...
```

Even 2-3 real projects is enough to start. Fill in the rest over time.

**Pick one as your test project** for development. Ideally one where:
- You've already had Loom meetings recorded
- There are existing Confluence docs you can index
- It's active (so new content keeps arriving during dev)

### 8. Write initial `config/people.yaml`

```yaml
people:
  - slug: you
    name: "Your Name"
    email: you@example.com
    projects: [project-alpha, project-beta]
    role: "Engineering"

  - slug: sarah
    name: "Sarah Example"
    email: sarah@example.com
    projects: [project-alpha]
    role: "Product"
```

Include yourself plus the people you meet with most. Can be expanded later as
you encounter new folks in meetings.

### 9. Prepare `.env.example` variables

You don't need values yet, just know what you're heading toward. `.env.example`
gets committed with blank values. Actual `.env` is gitignored.

```
# LLM - Primary: Windows Ollama via Tailscale
OLLAMA_HOST=http://<windows-tailscale-name>:11434
OLLAMA_MODEL=qwen3:14b
OLLAMA_FALLBACK_HOST=   # Mac Tailscale name, set when Mac Ollama added

# OpenRouter (for synthesis and when Ollama is unreachable)
OPENROUTER_API_KEY=
OPENROUTER_MODEL_SYNTHESIS=anthropic/claude-haiku-4.5
OPENROUTER_MODEL_FALLBACK=google/gemini-flash-1.5

# Upstream MCPs (localhost during dev; Tailscale hostname in production)
ENGRAM_MCP_URL=http://localhost:PORT
PERSONA_MCP_URL=http://localhost:PORT

# Adapter-specific (used by individual adapter packages)
LOOM_API_KEY=
ATLASSIAN_EMAIL=
ATLASSIAN_API_TOKEN=
ATLASSIAN_WORKSPACE=

# Runtime
NODE_ENV=development
LOG_LEVEL=info
```

## First Claude Code Session

Once everything above is checked, open Claude Code in the repo directory on
your Windows desktop. First prompt:

> Read CLAUDE.md, docs/ARCHITECTURE.md, docs/ROADMAP.md, and docs/DECISIONS.md.
> You have the full context, including the adapter framework and monorepo
> structure from ADR-008 and ADR-009.
>
> We are at Phase 1 of the roadmap. Generate the monorepo foundation:
>
> **Root-level:**
> - `package.json` (workspace root) with pnpm workspace config
> - `pnpm-workspace.yaml` declaring `packages/*`
> - `tsconfig.base.json` with shared compiler options
> - `.gitignore` (node_modules, dist, .env, credentials, .turbo)
> - `.gitattributes` (`* text=auto eol=lf`)
> - `.env.example` matching what's in docs/SETUP.md
> - `docker-compose.yml` for Cortex + Engram + Persona local dev
> - `.github/workflows/ci.yml` for lint + typecheck + test on PR
>
> **Packages:**
> - `packages/core/` — Empty but with package.json and src/ containing:
>   - `adapter.ts` exporting the SourceAdapter interface (with JSDoc but no
>     implementations)
>   - `types.ts` exporting NormalizedItem, ClassifiedItem, ContentType,
>     SourceType, HealthStatus, Attachment
>   - `context.ts` exporting AdapterContext interface
>   - `capabilities.ts` exporting AdapterCapabilities
>   - Proper index.ts barrel exports
> - `packages/adapter-sdk/` — package.json plus stub files for:
>   - `base-adapter.ts` (abstract class with TODO comments)
>   - `retry.ts`, `rate-limit.ts`, `idempotency.ts` (signatures only)
>   - `classifier-llm.ts`, `classifier-rule.ts` (signatures only)
> - `packages/pipeline-core/` — package.json plus src/pipeline.ts with the
>   generic pipeline interface signature (stub, no logic)
> - `packages/server/` — package.json plus:
>   - `src/mcp/server.ts` (MCP server skeleton, zero tools advertised yet)
>   - `src/clients/engram.ts` (typed client stub)
>   - `src/clients/persona.ts` (typed client stub)
>   - `src/llm/ollama.ts` (Ollama HTTP client — this one implement, it's
>     foundational. Call Qwen over Tailscale. Include health check.)
>   - `src/llm/openrouter.ts` (OpenRouter client — implement this too.
>     Include model fallback logic.)
>   - `src/registry.ts` (adapter registry — signatures only, no loading logic)
>   - `src/scheduler.ts` (signatures only)
> - `schemas/memory-metadata.json` — draft JSON Schema for the metadata
>   contract
> - `config/cortex.yaml` — example adapter config with all adapters set to
>   `enabled: false` for now
>
> **Constraints:**
> - TypeScript strict mode everywhere
> - ESM modules (`"type": "module"` in package.jsons)
> - Zod for validation
> - Vitest for testing
> - Cross-platform scripts (use cross-env where needed, no bash)
> - Use pnpm workspace protocol (`"workspace:*"`) for internal deps
> - Every package gets a README.md stub explaining its purpose
> - Implement the Ollama and OpenRouter clients with real (testable) code.
>   Everything else is interfaces, types, and TODO stubs.
>
> **Before executing:**
> - Show me the plan as a tree of files you'll create
> - Flag any decisions I haven't made yet
> - Confirm your understanding of the adapter contract from ARCHITECTURE.md
>
> Don't write logic for anything except the two LLM clients. The goal is
> structure and contracts that every future phase builds on.

Review the plan, push back on anything off, approve, let it execute. Commit
as "Phase 1: monorepo foundation and LLM clients." Then stop.

### Second session: verify the foundation

Before Phase 2, spend a short session confirming the structure actually
works:

> Run the tests in the Ollama client and OpenRouter client packages. Confirm
> they actually hit the configured endpoints and return sensible responses.
> For the Ollama client, send a test prompt to qwen3:14b and verify we get a
> response in reasonable time. For OpenRouter, send a test prompt to the
> configured synthesis model. Report any issues.

If both work, you have a solid foundation. Phase 2 starts in a new session.

## What Not to Do in Setup

- Don't commit credentials. Ever. Use `.env` (gitignored) only.
- Don't start building before `projects.yaml` has real content.
- Don't try to wire up all source credentials day one. Just Loom, Atlassian,
  and OpenRouter for now.
- Don't develop on the VPS. Develop on Windows, deploy to VPS.
- Don't put Ollama on the VPS. CCX13 doesn't have the RAM and it's CPU-only.
- Don't add adapters in Phase 1. That's for later phases. Phase 1 is just
  the framework.

## Cross-Platform Notes

**Line endings**: Git on Windows can convert LF to CRLF and break Linux
tooling on the VPS. Already set above: `git config --global core.autocrlf input`.
Also add a `.gitattributes` file to the repo (Claude Code will generate):

```
* text=auto eol=lf
```

**Path separators**: Always use Node's `path.join` and `path.sep`. Never
hardcode `/` or `\`. Claude Code should default to this but watch for
regressions in reviews.

**Shell scripts**: `.sh` files don't run on Windows natively. Use Node scripts
(`.mjs` or `.ts`) for tooling that runs in dev. Keep `.sh` files only for
VPS provisioning. If you really need bash locally, use WSL.

**Environment variables in npm scripts**: `SET VAR=value && ...` works on
Windows but breaks on Linux. Use `cross-env` (added as a dev dependency in
Phase 1) so scripts work identically everywhere.

**Docker Desktop on Windows**: required for the local-dev workflow that runs
Engram + Persona + Cortex together via docker-compose. Make sure WSL2 backend
is enabled — it's the default on Windows 11 but worth confirming.

**pnpm vs npm**: pnpm handles workspaces noticeably better for this kind of
monorepo. If you prefer npm workspaces, it'll work, but expect slower
installs and occasional weird hoisting. pnpm is worth the 60-second learning
curve.

## Ollama Notes

Your Windows Ollama is the primary extraction host. A few operational tips:

**Keep-alive**: The `OLLAMA_KEEP_ALIVE=30m` env var (set during install) keeps
the model in VRAM for 30 minutes between requests. Good for pipeline bursts.

**Memory management**: Qwen 3 14B uses ~10GB VRAM. You have 16GB, so plenty
of headroom. If you add a second model (e.g., embedding model), watch memory.
`ollama ps` shows what's currently loaded.

**Falling back to Mac**: When your desktop is off, Cortex should fall back to
Mac Ollama (if running) or OpenRouter. Set up Mac Ollama when you reach Phase
3 — it doesn't block anything earlier.

**Model upgrades**: Qwen 3 14B is the current recommendation. If better
14B-class models ship (or your VRAM grows), swap with `ollama pull <new>` and
update `OLLAMA_MODEL` in `.env`. Re-run fixture tests to confirm quality.

**Troubleshooting GPU detection**: If Ollama logs ever show CPU fallback,
restart the Ollama service. If it persists, check that `OLLAMA_VULKAN=1` is
still set in user env vars. AMD driver updates sometimes reset GPU detection.
