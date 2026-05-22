# GitHub adapter

Cortex's GitHub adapter ingests issues, pull requests, discussions, README
files, and selected repository documentation into the work memory backend.
Every memory it writes carries `source: "github"` and the repo's slug as
`project`, so existing search and digest tools find them automatically.

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

## What gets ingested

- README, ARCHITECTURE, ADR, and docs/ markdown files
- Open and recently-closed issues and pull requests
- Discussion threads
- Repo metadata (description, topics, primary language)

Codebase contents are *not* ingested by default — wire the future
`pipeline-code` package if you want that.

## References

- [Device authorization grant][device-grant]
- [Fine-grained personal access tokens][fine-grained]

[device-grant]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
[fine-grained]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens
