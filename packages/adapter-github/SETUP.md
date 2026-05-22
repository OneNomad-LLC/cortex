# GitHub adapter

Cortex's GitHub adapter ingests source repositories on a recurring
schedule and feeds them through the configured pipelines. Every memory
it writes carries `source: "github"`, the resolved project slug, and
the originating repo's `owner/name` in metadata, so the existing
`kb_search` / `digest` / dossier tools find them automatically.

## What "dossier mode" means (and why it's the default)

The adapter has three ingestion modes:

| Mode      | What it writes                                      | When to pick it                                                                |
|-----------|-----------------------------------------------------|--------------------------------------------------------------------------------|
| `dossier` | 1 brief + N decisions + N references per repo      | **Default.** You want answers about your repos, not raw source search.         |
| `full`    | Per-file chunks across every source file            | You need vector search over raw source files (refactor hunts, exact-line dives). |
| `both`    | Dossier *and* full file chunks                      | You want both retrieval modes and can pay the storage + LLM cost.              |

The legacy behavior — "chunk every file into the vector store" — is
still available as `mode: full`. We changed the default to `dossier`
because that's what Cortex is for: a **knowledge engine**, not a code
mirror. Asking "how does *project-x* handle auth?" should return the
distilled answer cortex already wrote down — not the top-K nearest
files where the substring "auth" appears.

### Example

With a repo synced in `dossier` mode, you can ask the connected MCP
client:

```
kb_search({ query: "how does payments handle auth" })
```

…and the matching memory is the dossier's Auth section, written once
by the code-dossier pipeline and kept fresh by SHA-gated re-derivation.
No file-walking, no embedding cost on every poll.

## Per-repo overrides

Most setups are uniform — one mode for every repo — but you can mix.
The `repoModes` config block accepts a per-repo override keyed by
`owner/name`:

```yaml
adapters:
  github:
    enabled: true
    mode: dossier             # adapter-level default
    repos:
      - acme/web
      - acme/api
      - acme/legacy-monolith
    repoModes:
      acme/legacy-monolith: full   # this one we actually grep
```

Repos absent from `repoModes` inherit the adapter-level `mode`.

## Recommended: sign in from the dashboard

Cortex bundles a one-click GitHub sign-in flow that takes care of token
minting and scope selection for you:

1. Open the dashboard login screen at **`/_dashboard/login`**.
2. Click **Continue with GitHub**.
3. A short device code is shown — copy it, then click **Open
   github.com/login/device**.
4. Paste the code on GitHub, approve the requested scopes, and return to
   the dashboard. The repos table appears at
   **`/_dashboard/integrations/github`**.

The dashboard flow uses GitHub's [device authorization grant][device-grant]
and stores the access token server-side as part of your dashboard session.
Required scopes: **`repo`**, **`read:user`**.

## Manual setup (personal access token)

If you'd rather paste a PAT, generate one at
<https://github.com/settings/tokens?type=beta>:

1. Click **Generate new token (fine-grained)**.
2. Pick the repositories Cortex should ingest from.
3. Grant **Contents: read**, **Issues: read**, **Pull requests: read**,
   **Discussions: read**, **Metadata: read**.
4. Copy the token and paste it in the wizard above as `GITHUB_TOKEN`.

## How scheduled syncs behave

Each scheduled sync iterates the configured repos and asks the
`ingest_repo` tool to refresh each one with the resolved mode. The
tool uses **SHA-gated re-derivation** — it records the last-seen HEAD
SHA per repo + mode and short-circuits when nothing has changed. In
practice the typical scheduled run is a no-op walk plus a cheap remote
SHA check; only repos that actually moved trigger re-ingestion.

## What gets ingested

- **Dossier mode**: a brief, the decisions cortex inferred from the
  codebase, and a deduped reference list. One small set of memories
  per repo; cheap to keep current.
- **Full mode**: README, ARCHITECTURE, ADR, and `docs/` markdown,
  plus the source files matching the configured `includeGlobs` and
  not matching `excludeGlobs`. One memory per chunk per file.
- **Both**: the union of the above.

Webhook-delivered push events use a fast per-file path independent of
the mode setting — push events are always processed as raw deltas.

## References

- [Device authorization grant][device-grant]
- [Fine-grained personal access tokens][fine-grained]

[device-grant]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
[fine-grained]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens
