# @onenomad/cortex-adapter-slack

Slack channels + threads source adapter. Reads channel history via
Slack's Web API, follows threads, and hands the concatenated
transcript to `@onenomad/cortex-pipeline-conversation`.

Config:

```yaml
adapters:
  slack:
    package: "@onenomad/cortex-adapter-slack"
    enabled: true
    schedule: "0 */2 * * *"
    config:
      channels: ["C0123ABCDE", "C0456FGHIJ"]   # channel ids
      historyDays: 7
      maxThreadsPerRun: 100
      channelToProject:                        # rule-based classifier
        C0123ABCDE: engineering
      defaultProject: ""
```

Required secret:

- `SLACK_BOT_TOKEN` — `xoxb-…` user/bot token with scopes
  `channels:history`, `channels:read`, `users:read`. Add the bot to
  every channel you want indexed.
