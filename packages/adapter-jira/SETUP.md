# Jira adapter

The Jira adapter ingests issues, comments, and changelogs matched by a JQL
filter. Memories carry `source: "jira"`; their `project` defaults to the
Jira project key (e.g. `CORTEX-123` → `cortex`).

## Create an API token

Jira shares its auth surface with Confluence — if you already created a
token there, reuse it. Otherwise:

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**, label it `Cortex`, copy the token.
3. Paste the token in the wizard above as `JIRA_API_TOKEN`.

## Wizard fields

- **Base URL** — your Atlassian site root, e.g.
  `https://yourcompany.atlassian.net`.
- **Email** — the email of the user the token belongs to.
- **JQL filter** — limits which issues get ingested. Sensible defaults:
  - Active work across all projects:
    `updated >= -90d AND statusCategory != Done`
  - One project only:
    `project = CORTEX AND updated >= -180d`

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
