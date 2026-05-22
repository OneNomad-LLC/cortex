#!/usr/bin/env bash
# Incremental upgrade for a cortex VPS deploy.
#
# This is the shell equivalent of `cortex update` — useful when the
# CLI isn't on PATH yet (e.g. first-time install or recovery).
#
# Default flow: pull the latest published image and recreate the
# container. Workspace state (PRZM_CORTEX_HOME_HOST bind-mount) is
# preserved untouched. Restart downtime ~5s.
#
# Usage:
#   ./deploy/update.sh                # pull + recreate
#   ./deploy/update.sh --build        # git pull + docker compose build + recreate
#   ./deploy/update.sh --skip-pull    # just recreate (use cached image)
#
# Assumes docker compose + a docker-compose.yml in the cwd or one
# level up.

set -euo pipefail

MODE=pull
SKIP_PULL=0
for arg in "$@"; do
  case "$arg" in
    --build) MODE=build ;;
    --skip-pull) SKIP_PULL=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) echo "update.sh: unknown flag '$arg'" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "update.sh: docker not found on PATH" >&2
  exit 127
fi

# Find docker-compose.yml — try cwd, then walk up one level.
if [[ -f docker-compose.yml ]]; then
  :
elif [[ -f ../docker-compose.yml ]]; then
  cd ..
else
  echo "update.sh: no docker-compose.yml in . or .." >&2
  exit 2
fi

if [[ "$SKIP_PULL" -eq 0 ]]; then
  if [[ "$MODE" == "build" ]]; then
    if [[ -d .git ]]; then
      echo "→ git pull --ff-only..."
      git pull --ff-only
    fi
    echo "→ docker compose build cortex..."
    docker compose build cortex
  else
    echo "→ docker compose pull cortex..."
    docker compose pull cortex
  fi
fi

echo "→ docker compose up -d --no-deps cortex..."
docker compose up -d --no-deps cortex

echo
echo "→ status:"
docker compose ps cortex
echo
echo "→ last 20 log lines:"
docker compose logs --tail 20 cortex
echo
echo "✓ cortex updated."
