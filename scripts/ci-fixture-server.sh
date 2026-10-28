#!/usr/bin/env bash
# CI helper for isolated browser-acceptance fixture servers.
#   start <name> <server.mjs>  start with a NEW sqlite under work/, wait until ready
#   stop  <name>               stop the recorded process and wait for ports to free
# Every failure prints the server log and exits non-zero; nothing is hidden.
set -u
WEB=http://127.0.0.1:4173/
API=http://127.0.0.1:8787/
TIMEOUT_TENTHS=${READY_TIMEOUT_TENTHS:-600}  # 60s

# Any HTTP response means the listener is up; the web root must also serve 200.
up() { [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$1")" != "000" ]; }
web_ok() { [ "$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$WEB")" = "200" ]; }
dump() { echo "::group::$1 server log"; cat "work/$1-server.log" 2>/dev/null || echo "(no log)"; echo "::endgroup::"; }

start() {
  name=$1; script=$2
  mkdir -p work
  if up "$WEB" || up "$API"; then echo "::error::Port 4173 or 8787 already in use before starting $name"; return 1; fi
  DATABASE_PATH="$PWD/work/$name-ci.sqlite" nohup node --experimental-sqlite "$script" > "work/$name-server.log" 2>&1 < /dev/null &
  pid=$!; echo "$pid" > "work/$name-server.pid"
  for _ in $(seq 1 "$TIMEOUT_TENTHS"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "::error::$name server exited before becoming ready"; dump "$name"; return 1
    fi
    if web_ok && up "$API"; then echo "$name server ready (pid $pid)"; return 0; fi
    sleep 0.1
  done
  echo "::error::$name server not ready on 4173/8787 within $((TIMEOUT_TENTHS / 10))s"; dump "$name"
  kill "$pid" 2>/dev/null || true
  return 1
}

stop() {
  name=$1
  [ -f "work/$name-server.pid" ] && kill "$(cat "work/$name-server.pid")" 2>/dev/null || true
  for _ in $(seq 1 100); do
    if ! up "$WEB" && ! up "$API"; then return 0; fi
    sleep 0.1
  done
  echo "::error::Ports still busy after stopping $name server"; dump "$name"; return 1
}

case "${1:-}" in
  start) start "$2" "$3" ;;
  stop) stop "$2" ;;
  *) echo "usage: $0 start|stop <name> [server.mjs]"; exit 2 ;;
esac
