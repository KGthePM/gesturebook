#!/usr/bin/env bash
# Start GestureBook: serve this folder and open it in your browser.
#   ./start.sh                first free port from 8787 upward
#   PORT=9000 ./start.sh      start at a different port
#   BIND=0.0.0.0 ./start.sh   also reachable from the local network
set -euo pipefail

cd "$(dirname "$0")"

BIND="${BIND:-127.0.0.1}"
PORT="${PORT:-8787}"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "error: PORT must be a number (got '$PORT')" >&2; exit 1; }

probe() {
  python3 -c 'import socket,sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind((sys.argv[1], int(sys.argv[2])))
except OSError:
    sys.exit(1)' "$BIND" "$1"
}

await_port() {
  python3 -c 'import socket,sys
s = socket.socket()
s.settimeout(0.3)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
except OSError:
    sys.exit(1)' "$BIND" "$1"
}

port=""
for (( p = PORT; p <= PORT + 9; p++ )); do
  if probe "$p"; then port=$p; break; fi
done
if [ -z "$port" ]; then
  echo "error: ports $PORT..$((PORT + 9)) are all in use; try PORT=<other>" >&2
  exit 1
fi

python3 -m http.server "$port" --bind "$BIND" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM

for _ in $(seq 1 50); do
  await_port "$port" && break
  sleep 0.1
done

url="http://localhost:$port"
printf '\n'
printf '%s\n' '──────────────────────────────────────────────'
printf '  GestureBook is running\n'
printf '  ➜  Open:  %s\n' "$url"
printf '  (Ctrl+C to stop)\n'
printf '%s\n' '──────────────────────────────────────────────'
printf '\n'

if [ -n "${BROWSER:-}" ]; then
  "$BROWSER" "$url" >/dev/null 2>&1 &
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$url" >/dev/null 2>&1 &
fi

wait "$server_pid" || true
