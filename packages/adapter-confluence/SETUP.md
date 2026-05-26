# Confluence adapter

The Confluence adapter ingests pages, blog posts, and attachments from
Atlassian Cloud Confluence spaces. Memories carry `source: "confluence"`
with the space key as `project`.

## Create an API token

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**. Label it `Cortex`.
3. Copy the token and paste it in the wizard above as
   `CONFLUENCE_API_TOKEN`.

## Wizard fields

- **Base URL** — your Atlassian site root, e.g.
  `https://yourcompany.atlassian.net/wiki`.
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
