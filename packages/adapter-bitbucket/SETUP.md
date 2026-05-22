# Bitbucket adapter

The Bitbucket adapter ingests repository metadata, pull requests, and
selected docs from Bitbucket Cloud. Memories carry `source: "bitbucket"`
with the repo slug as `project`.

## Create an app password

1. Open
   <https://bitbucket.org/account/settings/app-passwords/>.
2. Click **Create app password**. Label it `Cortex`.
3. Grant the following scopes:
   - **Account: Read**
   - **Workspaces: Read**
   - **Projects: Read**
   - **Repositories: Read**
   - **Pull requests: Read**
4. Copy the generated password and paste it in the wizard above as
   `BITBUCKET_APP_PASSWORD`.

## Wizard fields

- **Workspace** — the Bitbucket workspace slug (the part after
  `bitbucket.org/`).
- **Username** — your Atlassian username, **not** your email. App
  passwords don't accept email-based auth.
- **Repositories** — explicit slug list, or leave blank to ingest every
  repo the workspace user can read.

## References

- [App passwords][apppw]
- [Bitbucket Cloud REST API auth][auth]

[apppw]: https://support.atlassian.com/bitbucket-cloud/docs/app-passwords/
[auth]: https://developer.atlassian.com/cloud/bitbucket/rest/intro/#authentication
