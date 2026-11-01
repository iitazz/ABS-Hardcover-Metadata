#!/bin/sh
set -e
# Started as root (default): fix /data ownership, then run the app as PUID:PGID.
# Started with `user:` set in compose: run as that user directly (/data must be writable by it).
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
