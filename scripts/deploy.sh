#!/usr/bin/env bash
#
# Deploy Music Pusher on the server: pull latest, install deps, rebuild the
# client, and reload the PM2 process. Run from anywhere — it cd's to the repo.
#
#   npm run deploy
#
# Override the PM2 process name if yours differs:
#   PM2_APP_NAME=my-app npm run deploy
#
# A reload kills a running beet import mid-move, so the deploy refuses to start
# while one runs, and waits for one that started during the build. Override:
#   npm run deploy -- --force      (or FORCE=1 npm run deploy)
#
set -euo pipefail

APP_NAME="${PM2_APP_NAME:-music-pusher}"
FORCE="${FORCE:-}"
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

# Move to the repo root (this script lives in <root>/scripts).
cd "$(dirname "$0")/.."

# The album the running server is importing, or nothing. Asks the server itself
# (on the port .env gives it), so a server that is down or predates the route
# counts as idle.
import_running() {
  node --input-type=module -e "
    const { config } = await import('./server/config.js');
    try {
      const response = await fetch('http://127.0.0.1:' + config.port + '/api/import/active', {
        signal: AbortSignal.timeout(5000)
      });
      const { job } = await response.json();
      if (job) console.log(job.album);
    } catch {}
  " 2>/dev/null || true
}

if [ -z "$FORCE" ]; then
  album="$(import_running)"
  if [ -n "$album" ]; then
    echo "An import is running for '$album'. Deploying now would kill it mid-move." >&2
    echo "Wait for it to finish, or run 'npm run deploy -- --force'." >&2
    exit 1
  fi
fi

echo "==> Fetching latest from origin"
git fetch --prune origin

echo "==> Updating working tree (fast-forward only)"
git pull --ff-only

echo "==> Installing server dependencies"
npm install --omit=dev

echo "==> Installing client dependencies"
npm run client:install

echo "==> Building client"
npm run build

# One may have started while the build ran. The new code is already built, so
# wait it out rather than leave the old server serving the new client.
if [ -z "$FORCE" ]; then
  while album="$(import_running)" && [ -n "$album" ]; do
    echo "==> Waiting for the import of '$album' to finish before reloading (Ctrl-C to stop)"
    sleep 10
  done
fi

echo "==> Reloading PM2 process '$APP_NAME'"
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 reload "$APP_NAME" --update-env
elif pm2 describe music-dropbox > /dev/null 2>&1; then
  # Legacy process name from before the project was unified on "music-pusher".
  echo "Found legacy process 'music-dropbox' — reloading it instead"
  pm2 reload music-dropbox --update-env
else
  echo "PM2 process '$APP_NAME' not found — starting it from ecosystem.config.js"
  pm2 start ecosystem.config.js
fi

echo "==> Done"
pm2 status "$APP_NAME"
