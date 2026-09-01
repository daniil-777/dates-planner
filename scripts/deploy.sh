#!/usr/bin/env bash
#
# `npm run deploy` — fly deploy with the commit stamped into the frontend build.
#
# The build context has no `.git` (see .dockerignore), so the SHA is handed in as a build
# arg and `app/vite/buildStamp.ts` writes it into the bundle and into `app/dist/build.json`,
# where `/health` and Settings → Version read it. That stamp names HEAD — and `fly deploy`
# ships the working tree, not HEAD. So a dirty tree is refused: an image that says
# `8cea17b` while running code that is not in `8cea17b` is worse than no stamp at all.
# Commit first (the deploy is one command away), or set DEPLOY_DIRTY=1 to ship anyway
# with the stamp marked `-dirty`.
#
# Anything after `npm run deploy --` is passed on to fly: `npm run deploy -- --strategy immediate`.
set -euo pipefail

cd "$(dirname "$0")/.."

sha="$(git rev-parse --short=7 HEAD)"
if [ -n "$(git status --porcelain)" ]; then
  if [ -z "${DEPLOY_DIRTY:-}" ]; then
    echo "deploy: the working tree has uncommitted changes, and the build would be stamped as $sha." >&2
    echo "        Commit first, or DEPLOY_DIRTY=1 npm run deploy to stamp it $sha-dirty." >&2
    git status --short >&2
    exit 1
  fi
  sha="$sha-dirty"
fi

exec fly deploy --build-arg "GIT_SHA=$sha" "$@"
