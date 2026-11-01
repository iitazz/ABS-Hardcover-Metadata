#!/bin/sh
set -e
# Bind mounts are usually created as root; fix ownership, then drop privileges.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
