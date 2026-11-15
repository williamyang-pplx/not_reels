#!/bin/sh
# Dev helper: rebuild and (re)start the server on :3100 against /tmp/nr-dev.db
unset NODE_OPTIONS
cd "$(dirname "$0")/.." && node build.mjs 2>&1 | grep -v -i -E "browserslist|update-db|^$|Rebuilding|Done in"

# Reddit windows need Redlib. Start (or reuse) its container; without Docker the server runs with windows off.
# A running container is reused as is: run `docker rm -f nr-redlib` to apply changed settings or pull a new image.
REDLIB_PORT=8180
REDLIB_URL=
if docker info >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' | grep -qx nr-redlib ||
    { docker rm -f nr-redlib >/dev/null 2>&1
      docker run -d --name nr-redlib --restart unless-stopped -p 127.0.0.1:$REDLIB_PORT:8080 \
        -e REDLIB_DEFAULT_THEME=black -e REDLIB_DEFAULT_LAYOUT=card -e REDLIB_DEFAULT_HIDE_SIDEBAR_AND_SUMMARY=on \
        -e REDLIB_DEFAULT_FIXED_NAVBAR=off -e REDLIB_DEFAULT_USE_HLS=on -e REDLIB_DEFAULT_HIDE_HLS_NOTIFICATION=on \
        -e REDLIB_DEFAULT_DISABLE_VISIT_REDDIT_CONFIRMATION=on -e REDLIB_DEFAULT_BLUR_NSFW=on \
        -e REDLIB_ROBOTS_DISABLE_INDEXING=on ghcr.io/nachtalb/redlib:latest >/dev/null; }; then
    REDLIB_URL=http://127.0.0.1:$REDLIB_PORT
  else
    echo "redlib did not start (port $REDLIB_PORT taken?): Reddit windows are off"
  fi
else
  echo "docker is not running: Reddit windows are off"
fi

pkill -f "node dist/server.mjs" 2>/dev/null; sleep 0.2
REDLIB_URL=$REDLIB_URL DATABASE_URL=file:/tmp/nr-dev.db PORT=3100 nohup node dist/server.mjs > /tmp/nr-server.log 2>&1 &
sleep 0.4; curl -s -o /dev/null -w "up %{http_code}\n" localhost:3100/
