# Loom adapter

The Loom adapter pulls recordings (transcripts + metadata) from your Loom
library and pushes them through the meeting pipeline. Memories carry
`source: "loom"`, with `type` of `meeting`, `brief`, or `action_item`
depending on which pass produced them.

## Create an API key

1. Open <https://www.loom.com/settings/developer-api>.
2. Click **Generate new API key**, label it `Cortex`.
3. Copy the key and paste it in the wizard above as `LOOM_API_KEY`.

A Loom **Business** or **Enterprise** plan is required — the developer API
is not available on Starter.

## What gets ingested

- Recording title, description, owner, viewer count, share URL
- Full transcript when Loom has finished generating it (the adapter
  retries the next run if the transcript isn't ready)
- The transcript is fed through the meeting pipeline to produce a
  three-pass `brief` + extracted `action_item` memories

## References

- [Loom developer API][api]

[api]: https://dev.loom.com/docs/getting-started
