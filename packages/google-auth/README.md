# @onenomad/cortex-google-auth

Shared OAuth primitives for the Google adapters
(`adapter-google-calendar`, `adapter-google-drive`, `adapter-gmail`).

Cortex uses the **installed-app OAuth flow**: you authorize once via
`cortex google-auth login` (future), the refresh token is written to
`~/.cortex/google-token.json`, and subsequent adapter runs use the
refresh token to mint short-lived access tokens. No browser server
spin-up is required at sync time.

Exports:

- `GoogleAuthClient` — holds client_id/secret + refresh_token, mints
  access tokens on demand with caching
- `readGoogleToken` / `writeGoogleToken` — disk persistence for
  `~/.cortex/google-token.json`
- `GoogleApiError` — typed error with status + response body

Phase 1: this package implements the *refresh flow only*. The initial
authorization-code exchange (one-time, interactive) is a future wizard
command. For now, ship a refresh token from any OAuth playground or
`gcloud auth application-default` + paste it into the token file.
