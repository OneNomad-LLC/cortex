# Notion adapter

The Notion adapter ingests pages and database rows that have been
explicitly shared with a Notion integration. Memories carry
`source: "notion"`; their `project` defaults to the parent database title.

## Create an internal integration

1. Open <https://www.notion.so/my-integrations> and click **+ New
   integration**.
2. Name it `Cortex` and pick the workspace you want to ingest from.
3. Under **Capabilities**, enable **Read content** (and **Read comments**
   if you also want comment threads). Cortex never writes to Notion, so
   leave update/insert disabled.
4. Save. Copy the **Internal Integration Secret** (starts with
   `secret_…`) and paste it in the wizard above as `NOTION_TOKEN`.

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
