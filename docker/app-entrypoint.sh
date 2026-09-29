#!/bin/sh
# Starts the app as the unprivileged `node` user (1000:1000). When started as
# root, it first gives that user the group of the mounted Docker socket (its
# gid differs per host), and makes the data directory its own, then drops
# root. Started as any other user (e.g. `user:` in compose), it runs the
# command as is.
set -eu

APP_UID=1000
APP_GID=1000
SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

groups="$APP_GID"
if [ -S "$SOCKET" ]; then
  sock_gid="$(stat -c %g "$SOCKET")"
  groups="$groups,$sock_gid"
fi
if [ -n "${DOCKER_GID:-}" ]; then
  groups="$groups,$DOCKER_GID"
fi

data="${DATA_DIR:-/data}"
if [ -d "$data" ] && [ "$(stat -c %u "$data")" != "$APP_UID" ]; then
  chown -R "$APP_UID:$APP_GID" "$data"
fi

exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --groups="$groups" --inh-caps=-all --bounding-set=-all -- "$@"
