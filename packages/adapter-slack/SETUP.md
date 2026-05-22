# Slack adapter

The Slack adapter ingests channel history, threads, canvases, and uploaded
files from a Slack workspace. Memories land with `source: "slack"` and the
channel id as `project` (override per channel in
`config/projects.yaml`).

## Create a Slack app

1. Open <https://api.slack.com/apps> and click **Create New App** →
   **From scratch**.
2. Name it `Cortex` (or anything you'll recognize), choose the workspace
   you want to ingest from.
3. In **OAuth & Permissions** add the following bot scopes:
   - `channels:read`
   - `channels:history`
   - `groups:read` (private channels Cortex is invited to)
   - `groups:history`
   - `users:read`
   - `files:read`
4. Click **Install to Workspace**. After consent, copy the **Bot User
   OAuth Token** (starts with `xoxb-`) and paste it in the wizard above as
   `SLACK_BOT_TOKEN`.
5. Back in **Basic Information**, copy the **Signing Secret** and paste it
   as `SLACK_SIGNING_SECRET`. The adapter uses it to verify any future
   event-subscription deliveries.

## Invite the bot to channels

Cortex only sees channels the bot is a member of. In each channel you want
ingested, run `/invite @Cortex`.

## References

- [Slack OAuth & Permissions][oauth]
- [Slack signing secret][signing]

[oauth]: https://api.slack.com/authentication/oauth-v2
[signing]: https://api.slack.com/authentication/verifying-requests-from-slack
