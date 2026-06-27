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
set -euo pipefail

APP_NAME="${PM2_APP_NAME:-music-pusher}"

# Move to the repo root (this script lives in <root>/scripts).
cd "$(dirname "$0")/.."

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
