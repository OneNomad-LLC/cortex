#!/usr/bin/env bash
# cortex release helper — bump versions across all publishable packages,
# update CHANGELOG, commit, tag, and (optionally) publish to npm and
# push to origin (which kicks the GHCR docker-publish workflow).
#
# Usage:
#   scripts/release.sh                  # default: patch bump, interactive
#   scripts/release.sh patch            # 0.4.1 → 0.4.2
#   scripts/release.sh minor            # 0.4.1 → 0.5.0
#   scripts/release.sh major            # 0.4.1 → 1.0.0
#   scripts/release.sh 0.5.0            # explicit version
#
# Flags (after bump):
#   --no-publish   skip `pnpm publish` (npm registry)
#   --no-push      skip `git push --follow-tags`
#   --dry-run      do the bumps + CHANGELOG + diff, but no commit/tag/publish/push
#   --yes          don't prompt before each step
#
# Private packages (private: true in package.json) are left untouched —
# today that's `dashboard` and `memory-remote`. To publish the dashboard
# package, flip "private": false in packages/dashboard/package.json
# AND add "files": ["dist"] + a prepublish that runs `vite build`.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── parse args ──────────────────────────────────────────────────────
BUMP="patch"
PUBLISH=1
PUSH=1
DRY_RUN=0
YES=0

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    --no-publish) PUBLISH=0 ;;
    --no-push) PUSH=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *) echo "release.sh: unknown arg '$arg'" >&2; exit 2 ;;
  esac
done

confirm() {
  local prompt="$1"
  if [[ "$YES" -eq 1 ]]; then return 0; fi
  read -rp "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# ── pre-flight ──────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  echo "release: working tree is dirty. Commit or stash first." >&2
  exit 2
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "release: on branch '$CURRENT_BRANCH'"

# Pick the lowest non-private version as the canonical "current" — they
# should all match, but we don't assume.
CURRENT_VERSION=$(node -e "
const fs = require('fs');
const path = require('path');
const versions = new Set();
for (const dir of fs.readdirSync('packages')) {
  const pj = path.join('packages', dir, 'package.json');
  if (!fs.existsSync(pj)) continue;
  const j = JSON.parse(fs.readFileSync(pj, 'utf-8'));
  if (j.private) continue;
  versions.add(j.version);
}
const arr = [...versions].sort();
if (arr.length > 1) process.stderr.write('warn: versions drift: ' + arr.join(', ') + '\n');
process.stdout.write(arr[0]);
")
echo "release: current version: $CURRENT_VERSION"

# Compute next version
case "$BUMP" in
  patch|minor|major)
    NEXT_VERSION=$(node -e "
      const [maj, min, pat] = process.argv[1].split('.').map(Number);
      const bump = process.argv[2];
      if (bump === 'patch') console.log(\`\${maj}.\${min}.\${pat + 1}\`);
      else if (bump === 'minor') console.log(\`\${maj}.\${min + 1}.0\`);
      else if (bump === 'major') console.log(\`\${maj + 1}.0.0\`);
    " "$CURRENT_VERSION" "$BUMP")
    ;;
  *)
    NEXT_VERSION="$BUMP"
    ;;
esac

echo "release: next version: $NEXT_VERSION"
echo

if ! confirm "Bump all non-private packages from $CURRENT_VERSION → $NEXT_VERSION?"; then
  echo "release: aborted."
  exit 1
fi

# ── bump package versions ───────────────────────────────────────────
echo "→ bumping versions..."
for pj in packages/*/package.json; do
  is_private=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$pj','utf-8')).private === true)")
  if [[ "$is_private" == "true" ]]; then
    echo "  skip $(dirname $pj | sed 's|packages/||') (private)"
    continue
  fi
  node -e "
    const fs = require('fs');
    const j = JSON.parse(fs.readFileSync('$pj', 'utf-8'));
    j.version = '$NEXT_VERSION';
    fs.writeFileSync('$pj', JSON.stringify(j, null, 2) + '\n');
  "
  echo "  bumped $(dirname $pj | sed 's|packages/||') → $NEXT_VERSION"
done

# ── update CHANGELOG ────────────────────────────────────────────────
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
CHANGELOG_DATE=$(date +%Y-%m-%d)
# Build the git log args. When no prior tag exists, walk the full
# reachable history rather than a range. Avoid `| head -1` (SIGPIPE
# under pipefail when the pipe closes early).
if [[ -n "$LAST_TAG" ]]; then
  NOTES=$(git log --format='- %s' "${LAST_TAG}..HEAD" 2>/dev/null | grep -v '^- merge:' || echo "- (no commits since last release)")
else
  NOTES=$(git log --format='- %s' -n 50 2>/dev/null | grep -v '^- merge:' || echo "- (no commits since last release)")
fi

# Prepend new section to CHANGELOG.md (preserve existing content).
{
  head -3 CHANGELOG.md
  echo
  echo "## v${NEXT_VERSION} — ${CHANGELOG_DATE}"
  echo
  echo "${NOTES}"
  echo
  tail -n +4 CHANGELOG.md
} > CHANGELOG.md.new
mv CHANGELOG.md.new CHANGELOG.md
echo "→ CHANGELOG.md updated."

# ── diff summary ────────────────────────────────────────────────────
echo
echo "→ pending changes:"
git --no-pager diff --stat | tail -10
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "release: --dry-run, stopping here. Run \`git checkout -- packages CHANGELOG.md\` to revert."
  exit 0
fi

if ! confirm "Commit + tag v$NEXT_VERSION?"; then
  echo "release: aborted. Run \`git checkout -- packages CHANGELOG.md\` to revert."
  exit 1
fi

# ── commit + tag ────────────────────────────────────────────────────
git add packages CHANGELOG.md
git -c "user.name=Matt Stvartak" -c "user.email=hello@mattstvartak.com" commit -m "release: v${NEXT_VERSION}"
git tag -a "v${NEXT_VERSION}" -m "v${NEXT_VERSION}"
echo "→ committed + tagged v${NEXT_VERSION}."

# ── publish to npm (optional) ───────────────────────────────────────
if [[ "$PUBLISH" -eq 1 ]]; then
  if confirm "Publish all non-private packages to npm? (will prompt for OTP)"; then
    echo "→ pnpm publish -r --access public..."
    pnpm publish -r --access public --no-git-checks
    echo "→ published to npm."
  else
    echo "→ skipped npm publish."
  fi
fi

# ── push (optional) ─────────────────────────────────────────────────
if [[ "$PUSH" -eq 1 ]]; then
  if confirm "Push commit + tags to origin (kicks GHCR docker-publish workflow)?"; then
    git push origin "$CURRENT_BRANCH" --follow-tags
    echo "→ pushed. The docker-publish workflow will build the image at:"
    echo "    ghcr.io/onenomad-llc/przm-cortex:latest"
    echo "    ghcr.io/onenomad-llc/przm-cortex:v${NEXT_VERSION}"
    echo "  Watch progress: https://github.com/OneNomad-LLC/cortex/actions"
  else
    echo "→ skipped push. When ready: git push origin $CURRENT_BRANCH --follow-tags"
  fi
fi

echo
echo "✓ release v${NEXT_VERSION} complete."
