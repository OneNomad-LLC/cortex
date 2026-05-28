#!/usr/bin/env bash
# OSS install smoke test.
#
# Verifies the open-source install path works end-to-end with NO license
# configured. The audit (oss-parity-check.yml) proves no feature gates
# exist in source; this proves the install actually runs.
#
# What it does (in this order):
#   1. Asserts no PRZM_LICENSE* env vars are set (the parity claim).
#   2. Builds the cortex container from the current checkout (no published
#      image dependency — we test the code on this branch).
#   3. Starts the cortex service via docker compose. Uses the default
#      profile: embedded PGlite, no external Postgres, no LLM provider.
#   4. Waits for /health to return 200.
#   5. Confirms the server boots and serves API without any license
#      configuration.
#
# Tenant-scoped search + cross-tenant isolation assertions are a future
# extension: they require standing up przm-access alongside cortex with
# two tenants seeded, which is heavier than this script's <2-minute
# budget. The parity claim is "OSS install runs every feature" — this
# smoke test verifies the install boots and serves; the per-feature
# unit/integration tests in packages/server cover the behavior surface.
#
# Usage:
#   bash scripts/smoke-oss.sh
#
# Exits 0 on success, non-zero on failure.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ---------------------------------------------------------------------------
# 1. License env var assertion
# ---------------------------------------------------------------------------
echo "[smoke-oss] checking environment for license configuration..."
license_vars=()
while IFS='=' read -r name _; do
  case "$name" in
    PRZM_LICENSE*|PRZM_CORTEX_LICENSE*) license_vars+=("$name") ;;
  esac
done < <(env)

if [[ ${#license_vars[@]} -gt 0 ]]; then
  echo "[smoke-oss] FAIL: license env vars set: ${license_vars[*]}" >&2
  echo "[smoke-oss] The OSS parity claim is 'works without a license' — unset these and rerun." >&2
  exit 1
fi
echo "[smoke-oss] ok: no PRZM_LICENSE* env vars set"

# ---------------------------------------------------------------------------
# 2. Build the image from the current tree
# ---------------------------------------------------------------------------
# Override CORTEX_IMAGE so docker compose builds against the local
# Dockerfile rather than pulling the published image. The build block in
# docker-compose.yml points at packages/server/Dockerfile.
export CORTEX_IMAGE="cortex:smoke-oss"

# Use a smoke-test-only data dir so we don't collide with any local
# workspace and can clean up at exit.
SMOKE_HOME="$(mktemp -d -t cortex-smoke-XXXXXX)"
export PRZM_CORTEX_HOME_HOST="$SMOKE_HOME"

# Pick free-ish ports above the default to avoid clashing with a dev
# instance someone already has running on 3100/4141.
export PRZM_CORTEX_MCP_PORT="${PRZM_CORTEX_MCP_PORT:-31000}"
export PRZM_CORTEX_API_PORT="${PRZM_CORTEX_API_PORT:-41410}"

cleanup() {
  echo "[smoke-oss] tearing down..."
  docker compose down -v --remove-orphans 2>/dev/null || true
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT

echo "[smoke-oss] building cortex image (cortex:smoke-oss)..."
docker compose build cortex

# ---------------------------------------------------------------------------
# 3. Start the service
# ---------------------------------------------------------------------------
echo "[smoke-oss] starting cortex (default profile: embedded PGlite, no LLM)..."
docker compose up -d cortex

# ---------------------------------------------------------------------------
# 4. Wait for /health
# ---------------------------------------------------------------------------
health_url="http://127.0.0.1:${PRZM_CORTEX_API_PORT}/health"
echo "[smoke-oss] waiting for $health_url ..."

deadline=$((SECONDS + 90))
ok=0
while (( SECONDS < deadline )); do
  if curl -fsS --max-time 2 "$health_url" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if (( ok == 0 )); then
  echo "[smoke-oss] FAIL: $health_url did not respond within 90s" >&2
  echo "[smoke-oss] container logs:" >&2
  docker compose logs cortex --tail 100 >&2 || true
  exit 1
fi
echo "[smoke-oss] ok: /health responded"

# ---------------------------------------------------------------------------
# 5. Confirm the JSON shape
# ---------------------------------------------------------------------------
body=$(curl -fsS "$health_url")
echo "[smoke-oss] /health body: $body"

# Cheap shape check — the route returns { ok: true, version, widgets }.
if ! grep -q '"ok":true' <<< "$body"; then
  echo "[smoke-oss] FAIL: /health did not return { ok: true }" >&2
  exit 1
fi

echo "[smoke-oss] PASS — OSS install boots and serves with no license configured"
