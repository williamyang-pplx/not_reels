#!/bin/sh
# Container entrypoint (Dockerfile CMD): Redlib for the Reddit windows on loopback only, restarted if it exits,
# then the app in the foreground. The app reaches Redlib through REDLIB_URL (fly.toml) and proxies it same-origin.
(
  while true; do
    redlib -a 127.0.0.1 -p 8080
    echo "[redlib] exited with $?, restarting in 1 s"
    sleep 1
  done
) &
exec node dist/server.mjs
