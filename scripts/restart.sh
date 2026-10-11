#!/bin/sh
# Dev helper: rebuild and (re)start the server on :3100 against /tmp/nr-dev.db
unset NODE_OPTIONS
cd "$(dirname "$0")/.." && node build.mjs 2>&1 | grep -v -i -E "browserslist|update-db|^$|Rebuilding|Done in"
pkill -f "node dist/server.mjs" 2>/dev/null; sleep 0.2
DATABASE_URL=file:/tmp/nr-dev.db PORT=3100 nohup node dist/server.mjs > /tmp/nr-server.log 2>&1 &
sleep 0.4; curl -s -o /dev/null -w "up %{http_code}\n" localhost:3100/
