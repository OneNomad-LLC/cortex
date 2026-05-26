# Linear adapter

The Linear adapter ingests issues, comments, projects, and cycle history.
Memories carry `source: "linear"`; their `project` is the Linear team
slug.

## Create a personal API key

1. Open <https://linear.app/settings/api>.
2. Under **Personal API keys**, click **Create key**.
3. Label it `Cortex`. Linear keys are scoped to the user's permissions,
   so create the key under an account that can see the teams you want
   ingested.
4. Copy the key (starts with `lin_api_…`) and paste it in the wizard
   above as `LINEAR_API_KEY`.

## Wizard fields

- **Teams** — list of team slugs to ingest (leave blank to ingest every
  team the user can read).
- **Since** — earliest `updatedAt` to pull on the first run (default
  `-90d`). Subsequent runs use Linear's cursor pagination.

## References

- [Linear API docs][docs]
- [GraphQL schema explorer][gql]

[docs]: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
[gql]: https://studio.apollographql.com/public/Linear-API/home
