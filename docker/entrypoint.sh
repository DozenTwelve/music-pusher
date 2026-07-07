#!/bin/sh
# Start as root just long enough to align ownership, then drop to PUID/PGID so
# every file this app writes matches what the Navidrome container can read.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Folders this app owns. /music is the shared library — ensure it exists but do
# NOT recursively chown it: it may be large and owned by Navidrome already.
mkdir -p "$RAW_DIR" "$BEETSDIR" "$LIBRARY_DIR"
chown -R "$PUID:$PGID" "$RAW_DIR" "$BEETSDIR" 2>/dev/null || true

# gosu takes a numeric uid:gid, so no user/group renaming is needed.
exec gosu "$PUID:$PGID" "$@"
