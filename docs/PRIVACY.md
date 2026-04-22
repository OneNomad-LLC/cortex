# Privacy & Identifier Hygiene

Cortex is a private repo carrying data that could become client-sensitive the
moment real deployments start. This doc is the rule: **no real identifiers in
committed files, ever.** Real data lives in three places, none of which are
in git:

| What | Where |
|---|---|
| Credentials (API tokens, emails, client secrets) | `.env` |
| Client-specific config (workspace names, space keys, client slugs) | `config/*.local.yaml` |
| Per-user runtime state (approvals, heartbeat, personal Engram data) | `~/.cortex/` or `.cortex/` |

All three are in `.gitignore`.

## What counts as an identifier

Things that must **never** appear in a committed file:

- Real people's names or emails (your own `author` byline in `package.json` is
  fine — that's your product's identity, not a client's)
- Client company names (e.g., "Driven Brands", "Acme Corp")
- Sub-brand or product names derived from clients (e.g., "Jiffy Lube", "Meineke")
- Workspace subdomains (e.g., `mycompany.atlassian.net`, `mycompany.slack.com`)
- Slack channel names that reveal a client
- Jira project keys that encode a client
- Internal URLs (`cortex.mycompany.ts.net`, etc.)
- GitHub repo paths that name a client
- Client-specific test fixtures (sample transcripts, real meeting content)

Vendor **domain structures** are fine because every user of a vendor shares
them — e.g., `<workspace>.atlassian.net` in an adapter's URL construction code
is not a leak, it's how the Atlassian REST API works.

## The `.local.yaml` override pattern

The config loader prefers `<name>.local.yaml` over `<name>.yaml` whenever both
exist. The `.yaml` version is a committed template with placeholders; the
`.local.yaml` version is yours and lives only on your disk.

```
config/
  cortex.yaml           # committed, generic, placeholders
  cortex.local.yaml     # your real config, gitignored
  projects.yaml         # committed template
  projects.local.yaml   # your real projects, gitignored
  people.yaml           # committed template
  people.local.yaml     # your real roster, gitignored
  engagements.yaml      # committed template (when added)
  engagements.local.yaml # your real engagements, gitignored
```

First-run: copy `config/cortex.yaml` to `config/cortex.local.yaml` and fill in
the real values. The adapter schemas and placeholders live in the `.yaml`
template so new installs work without a committed secret; your deployment
writes the `.local.yaml` once and never touches it again.

## Pre-commit hook

`scripts/pre-commit-scan.sh` runs a grep pass on staged files for common
identifier patterns. It blocks the commit if it finds:

- Email addresses (except `@example.com`, `@example.org`, `@cortex.local`)
- Atlassian workspace subdomains (`<word>.atlassian.net`) where `<word>` isn't
  a known placeholder (`yourcompany`, `example`, `acme`)
- Slack workspace patterns (`<word>.slack.com`)
- Specific names from the ignore list (`client-names.local.txt` — not
  committed; you maintain your own list)

Install the hook (cross-platform, Node-based — works in PowerShell, cmd,
bash, zsh):

```bash
node scripts/install-hooks.mjs
```

A bash equivalent exists for macOS/Linux users who prefer it:

```bash
bash scripts/install-hooks.sh
```

If the scan is wrong about a file, add the pattern to `scripts/identifier-scan-allow.txt`
(committed) or bypass with `git commit --no-verify`. **Never bypass silently
when you know the commit would land a real identifier.**

CI runs the same scan on every PR as a belt-and-suspenders check in case
someone committed with `--no-verify`.

## What leaks already been scrubbed

Historical audit (2026-04-22) scrubbed five spots:

- `README.md` — generic `<your-cortex-repo-url>` clone instruction
- `docs/SETUP.md` — generic engram/persona repo URLs; example `people.yaml`
  uses `Your Name` / `you@example.com`
- `packages/provider-openrouter/README.md` — referer example omitted;
  provider's default (`https://cortex.local`) applies
- `packages/server/src/cli/write-config.ts` — wizard no longer emits a
  personal referer URL

Git commit author metadata (`Matt Stvartak <hello@mattstvartak.com>`) is left
in place; rewriting history would be destructive and the product author's
byline in commits is standard practice for a closed-source commercial project.

## When a real customer onboards

When the first external deployment happens, review this doc plus the three
exclusion lists (`.gitignore`, `scripts/identifier-scan-allow.txt`, and your
local client-name list). Add anything they named. Then make sure they know
the same pattern: their real config goes in `config/*.local.yaml` on their
box, never in a fork they push back.
