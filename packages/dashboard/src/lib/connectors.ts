/**
 * Catalog metadata for the Connectors directory page. Mirrors the
 * adapter packages in `packages/adapter-*` but lives client-side so the
 * SPA can render the directory without an extra round-trip.
 *
 * `setupMarkdown` is the canonical `SETUP.md` body for each adapter.
 * For now it's embedded into the dashboard bundle as a TypeScript
 * string — there's a parallel `SETUP.md` file checked into each
 * `packages/adapter-<id>/` for documentation purposes. A future slice
 * will swap this for a server-side `GET /api/dashboard/adapters/:id/setup`
 * route that resolves the file out of `node_modules` (the same trick
 * the dashboard static-asset resolver uses). Until then, keep the two
 * in sync manually.
 *
 * Adapter ids match the slug the server's adapter registry uses, so a
 * connector card's "Connected" state can be derived by checking whether
 * `/api/dashboard/adapters` returns a row whose `id` (or `slug`) equals
 * the connector id.
 */

export interface ConnectorDef {
  /** Stable id matching the adapter slug on the server. */
  id: string;
  name: string;
  /** One-line summary shown on the directory card. */
  description: string;
  /**
   * Whether the connector supports the one-click "Continue with
   * <provider>" flow. Currently only GitHub.
   */
  oauthFlow: boolean;
  /** Canonical `SETUP.md` content embedded into the bundle. */
  setupMarkdown: string;
}

// Inline the markdown bodies here. Vite's `?raw` query can't reach
// outside the package without monorepo-wide config gymnastics, so we
// duplicate the prose. Keep these in sync with `packages/adapter-<id>/SETUP.md`.

const GITHUB_SETUP = `# GitHub adapter

Cortex's GitHub adapter ingests issues, pull requests, discussions, README
files, and selected repository documentation into the work memory backend.
Every memory it writes carries \`source: "github"\` and the repo's slug as
\`project\`, so existing search and digest tools find them automatically.

## Recommended: sign in from the dashboard

Cortex bundles a one-click GitHub sign-in flow that takes care of token
minting and scope selection for you:

1. Open the dashboard login screen at **\`/_dashboard/login\`**.
2. Click **Continue with GitHub**.
3. A short device code is shown — copy it, then click **Open
   github.com/login/device**.
4. Paste the code on GitHub, approve the requested scopes, and return to
   the dashboard. The repos table appears at
   **\`/_dashboard/integrations/github\`**.

The dashboard flow uses GitHub's [device authorization grant][device-grant]
and stores the access token server-side as part of your dashboard session.
Required scopes: **\`repo\`**, **\`read:user\`**.

## Manual setup (personal access token)

If you'd rather paste a PAT, generate one at
<https://github.com/settings/tokens?type=beta>:

1. Click **Generate new token (fine-grained)**.
2. Pick the repositories Cortex should ingest from.
3. Grant **Contents: read**, **Issues: read**, **Pull requests: read**,
   **Discussions: read**, **Metadata: read**.
4. Copy the token and paste it in the wizard above as \`GITHUB_TOKEN\`.

## What gets ingested

- README, ARCHITECTURE, ADR, and docs/ markdown files
- Open and recently-closed issues and pull requests
- Discussion threads
- Repo metadata (description, topics, primary language)

Codebase contents are *not* ingested by default — wire the future
\`pipeline-code\` package if you want that.

## References

- [Device authorization grant][device-grant]
- [Fine-grained personal access tokens][fine-grained]

[device-grant]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
[fine-grained]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens
`;

const SLACK_SETUP = `# Slack adapter

The Slack adapter ingests channel history, threads, canvases, and uploaded
files from a Slack workspace. Memories land with \`source: "slack"\` and the
channel id as \`project\` (override per channel in
\`config/projects.yaml\`).

## Create a Slack app

1. Open <https://api.slack.com/apps> and click **Create New App** →
   **From scratch**.
2. Name it \`Cortex\` (or anything you'll recognize), choose the workspace
   you want to ingest from.
3. In **OAuth & Permissions** add the following bot scopes:
   - \`channels:read\`
   - \`channels:history\`
   - \`groups:read\` (private channels Cortex is invited to)
   - \`groups:history\`
   - \`users:read\`
   - \`files:read\`
4. Click **Install to Workspace**. After consent, copy the **Bot User
   OAuth Token** (starts with \`xoxb-\`) and paste it in the wizard above as
   \`SLACK_BOT_TOKEN\`.
5. Back in **Basic Information**, copy the **Signing Secret** and paste it
   as \`SLACK_SIGNING_SECRET\`. The adapter uses it to verify any future
   event-subscription deliveries.

## Invite the bot to channels

Cortex only sees channels the bot is a member of. In each channel you want
ingested, run \`/invite @Cortex\`.

## References

- [Slack OAuth & Permissions][oauth]
- [Slack signing secret][signing]

[oauth]: https://api.slack.com/authentication/oauth-v2
[signing]: https://api.slack.com/authentication/verifying-requests-from-slack
`;

const NOTION_SETUP = `# Notion adapter

The Notion adapter ingests pages and database rows that have been
explicitly shared with a Notion integration. Memories carry
\`source: "notion"\`; their \`project\` defaults to the parent database title.

## Create an internal integration

1. Open <https://www.notion.so/my-integrations> and click **+ New
   integration**.
2. Name it \`Cortex\` and pick the workspace you want to ingest from.
3. Under **Capabilities**, enable **Read content** (and **Read comments**
   if you also want comment threads). Cortex never writes to Notion, so
   leave update/insert disabled.
4. Save. Copy the **Internal Integration Secret** (starts with
   \`secret_…\`) and paste it in the wizard above as \`NOTION_TOKEN\`.

## Share the right pages with the integration

This is the step that catches people: a Notion integration only sees
content explicitly shared with it.

1. Open each top-level page or database you want Cortex to ingest.
2. Click **…** → **Add connections** → choose **Cortex**.
3. Sharing propagates to sub-pages automatically. Anything outside that
   tree stays invisible to the adapter.

## References

- [Create an integration][integration]
- [Sharing pages with an integration][share]

[integration]: https://developers.notion.com/docs/create-a-notion-integration
[share]: https://developers.notion.com/docs/create-a-notion-integration#give-your-integration-page-permissions
`;

const CONFLUENCE_SETUP = `# Confluence adapter

The Confluence adapter ingests pages, blog posts, and attachments from
Atlassian Cloud Confluence spaces. Memories carry \`source: "confluence"\`
with the space key as \`project\`.

## Create an API token

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**. Label it \`Cortex\`.
3. Copy the token and paste it in the wizard above as
   \`CONFLUENCE_API_TOKEN\`.

## Wizard fields

- **Base URL** — your Atlassian site root, e.g.
  \`https://yourcompany.atlassian.net/wiki\`.
- **Email** — the email of the user the token belongs to. Confluence
  ties API access to the token *owner*, so this user must have access to
  every space you list.
- **Spaces** — list of space keys to ingest from (leave blank to ingest
  every space the user can read).

## Permissions

The Atlassian API token inherits the owner's permissions. For Cortex,
the safest pattern is a dedicated bot user that has been granted
**View** permission on the spaces you want ingested (and nothing else).

## References

- [Atlassian API tokens][token]
- [Confluence Cloud REST API auth][auth]

[token]: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
[auth]: https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/
`;

const JIRA_SETUP = `# Jira adapter

The Jira adapter ingests issues, comments, and changelogs matched by a JQL
filter. Memories carry \`source: "jira"\`; their \`project\` defaults to the
Jira project key (e.g. \`CORTEX-123\` → \`cortex\`).

## Create an API token

Jira shares its auth surface with Confluence — if you already created a
token there, reuse it. Otherwise:

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**, label it \`Cortex\`, copy the token.
3. Paste the token in the wizard above as \`JIRA_API_TOKEN\`.

## Wizard fields

- **Base URL** — your Atlassian site root, e.g.
  \`https://yourcompany.atlassian.net\`.
- **Email** — the email of the user the token belongs to.
- **JQL filter** — limits which issues get ingested. Sensible defaults:
  - Active work across all projects:
    \`updated >= -90d AND statusCategory != Done\`
  - One project only:
    \`project = CORTEX AND updated >= -180d\`

The adapter re-runs this query on its schedule and applies idempotent
updates, so it's safe to widen the filter later.

## Permissions

The token inherits the owner's permissions. Make sure the user account
has **Browse projects** on every project the filter touches.

## References

- [Atlassian API tokens][token]
- [JQL reference][jql]

[token]: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
[jql]: https://support.atlassian.com/jira-service-management-cloud/docs/use-advanced-search-with-jira-query-language-jql/
`;

const BITBUCKET_SETUP = `# Bitbucket adapter

The Bitbucket adapter ingests repository metadata, pull requests, and
selected docs from Bitbucket Cloud. Memories carry \`source: "bitbucket"\`
with the repo slug as \`project\`.

## Create an app password

1. Open
   <https://bitbucket.org/account/settings/app-passwords/>.
2. Click **Create app password**. Label it \`Cortex\`.
3. Grant the following scopes:
   - **Account: Read**
   - **Workspaces: Read**
   - **Projects: Read**
   - **Repositories: Read**
   - **Pull requests: Read**
4. Copy the generated password and paste it in the wizard above as
   \`BITBUCKET_APP_PASSWORD\`.

## Wizard fields

- **Workspace** — the Bitbucket workspace slug (the part after
  \`bitbucket.org/\`).
- **Username** — your Atlassian username, **not** your email. App
  passwords don't accept email-based auth.
- **Repositories** — explicit slug list, or leave blank to ingest every
  repo the workspace user can read.

## References

- [App passwords][apppw]
- [Bitbucket Cloud REST API auth][auth]

[apppw]: https://support.atlassian.com/bitbucket-cloud/docs/app-passwords/
[auth]: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#authentication
`;

const LINEAR_SETUP = `# Linear adapter

The Linear adapter ingests issues, comments, projects, and cycle history.
Memories carry \`source: "linear"\`; their \`project\` is the Linear team
slug.

## Create a personal API key

1. Open <https://linear.app/settings/api>.
2. Under **Personal API keys**, click **Create key**.
3. Label it \`Cortex\`. Linear keys are scoped to the user's permissions,
   so create the key under an account that can see the teams you want
   ingested.
4. Copy the key (starts with \`lin_api_…\`) and paste it in the wizard
   above as \`LINEAR_API_KEY\`.

## Wizard fields

- **Teams** — list of team slugs to ingest (leave blank to ingest every
  team the user can read).
- **Since** — earliest \`updatedAt\` to pull on the first run (default
  \`-90d\`). Subsequent runs use Linear's cursor pagination.

## References

- [Linear API docs][docs]
- [GraphQL schema explorer][gql]

[docs]: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
[gql]: https://studio.apollographql.com/public/Linear-API/home
`;

const LOOM_SETUP = `# Loom adapter

The Loom adapter pulls recordings (transcripts + metadata) from your Loom
library and pushes them through the meeting pipeline. Memories carry
\`source: "loom"\`, with \`type\` of \`meeting\`, \`brief\`, or \`action_item\`
depending on which pass produced them.

## Create an API key

1. Open <https://www.loom.com/settings/developer-api>.
2. Click **Generate new API key**, label it \`Cortex\`.
3. Copy the key and paste it in the wizard above as \`LOOM_API_KEY\`.

A Loom **Business** or **Enterprise** plan is required — the developer API
is not available on Starter.

## What gets ingested

- Recording title, description, owner, viewer count, share URL
- Full transcript when Loom has finished generating it (the adapter
  retries the next run if the transcript isn't ready)
- The transcript is fed through the meeting pipeline to produce a
  three-pass \`brief\` + extracted \`action_item\` memories

## References

- [Loom developer API][api]

[api]: https://dev.loom.com/docs/getting-started
`;

const OBSIDIAN_SETUP = `# Obsidian adapter

The Obsidian adapter watches a local vault directory and ingests every
markdown file it finds. Memories carry \`source: "obsidian"\`; their
\`project\` is inferred from the top-level folder under the vault root.

No token required — Cortex reads the vault directly from disk.

## Wizard fields

- **Vault path** — absolute path to your Obsidian vault root. Example:
  \`/Users/matt/Documents/work-vault\`. Cortex must be running as a user
  with read access to that directory.
- **Ignore globs** — optional list of glob patterns (relative to the
  vault root) that should be skipped. Sensible defaults:
  - \`.obsidian/**\` (Obsidian's own config)
  - \`_archive/**\`
  - \`**/.trash/**\`

## How project tagging works

The adapter looks for a \`project: <slug>\` line in the file's YAML front
matter first. Failing that, it uses the top-level folder under the vault
root. If both are missing, the memory is tagged \`project: "inbox"\` and
shows up under "Unfiled" in the dashboard.

## Watch vs. poll

By default the adapter uses Node's \`fs.watch\` to react to edits within
seconds. On network mounts where watch events don't propagate, set the
\`OBSIDIAN_POLL_MS\` env var to a non-zero millisecond value to switch to
polling.

## References

- [Obsidian vault structure][vault]
- [YAML front matter in Obsidian][frontmatter]

[vault]: https://help.obsidian.md/Files+and+folders/Vault
[frontmatter]: https://help.obsidian.md/Editing+and+formatting/Properties
`;

export const CONNECTORS: ReadonlyArray<ConnectorDef> = [
  {
    id: "github",
    name: "GitHub",
    description:
      "Issues, pull requests, discussions, and docs from your GitHub repos.",
    oauthFlow: true,
    setupMarkdown: GITHUB_SETUP,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channel history, threads, and shared files.",
    oauthFlow: false,
    setupMarkdown: SLACK_SETUP,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages and database rows shared with the Cortex integration.",
    oauthFlow: false,
    setupMarkdown: NOTION_SETUP,
  },
  {
    id: "confluence",
    name: "Confluence",
    description: "Atlassian Cloud Confluence pages, blogs, and attachments.",
    oauthFlow: false,
    setupMarkdown: CONFLUENCE_SETUP,
  },
  {
    id: "jira",
    name: "Jira",
    description: "Issues, comments, and changelogs matched by a JQL filter.",
    oauthFlow: false,
    setupMarkdown: JIRA_SETUP,
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    description:
      "Bitbucket Cloud repos, pull requests, and selected documentation.",
    oauthFlow: false,
    setupMarkdown: BITBUCKET_SETUP,
  },
  {
    id: "linear",
    name: "Linear",
    description: "Linear issues, projects, comments, and cycle history.",
    oauthFlow: false,
    setupMarkdown: LINEAR_SETUP,
  },
  {
    id: "loom",
    name: "Loom",
    description:
      "Loom recordings, transcripts, and the meeting pipeline outputs.",
    oauthFlow: false,
    setupMarkdown: LOOM_SETUP,
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Local Obsidian vault markdown files.",
    oauthFlow: false,
    setupMarkdown: OBSIDIAN_SETUP,
  },
];

export function findConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}
