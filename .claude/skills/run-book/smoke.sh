#!/usr/bin/env bash
# End-to-end smoke test for Book: boots the real TUI in a PTY against the mock
# provider and drives one full flow — prompt -> tool call -> permission dialog ->
# approval -> file written on disk. Exits non-zero on any failure.
#
#   bash .claude/skills/run-book/smoke.sh
#
# Requires: npm run build (dist/) and a built node-pty (npm rebuild node-pty).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PORT="${BOOK_SMOKE_PORT:-8919}"
# Per-port defaults, so two smoke runs on different ports share no files either.
WS="${BOOK_SMOKE_WS:-/tmp/book-smoke-ws-$PORT}"
SHOTS="${BOOK_SMOKE_SHOTS:-/tmp/book-shots-$PORT}"
SCENARIO="/tmp/book-smoke-scenario-$PORT.json"

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "smoke: dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi

# The driver starts the mock and kills that one PID on every exit path, signals
# included. Nothing here kills a mock by name: on a shared machine the other
# mocks belong to other runs. Pick another port with BOOK_SMOKE_PORT.
#
# Nothing is deleted until this run owns the port: first a per-port lock (another
# smoke run on the same port stops here, before touching its workspace), then a
# probe that the port is free (a foreign holder stops us the same way).
LOCK="/tmp/book-smoke-$PORT.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$LOCK" # its run died without cleaning up
    mkdir "$LOCK"
  else
    echo "smoke: another smoke run (pid ${holder:-?}) holds port $PORT; set BOOK_SMOKE_PORT" >&2
    exit 1
  fi
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

if ! node -e "const s = require('net').createServer();
  s.once('error', () => process.exit(1));
  s.listen($PORT, '127.0.0.1', () => s.close());"; then
  echo "smoke: port $PORT is in use by another process; set BOOK_SMOKE_PORT" >&2
  exit 1
fi

rm -rf "$WS"
mkdir -p "$WS"
git -C "$WS" init -q .

cat > "$SCENARIO" <<'JSON'
[
  { "tool": { "name": "Write", "arguments": { "file_path": "smoke.txt", "content": "written by the smoke test\n" } } },
  { "text": "Wrote the file. SMOKE-DONE" }
]
JSON

node "$HERE/driver.mjs" --mock --mock-port "$PORT" --mock-script "$SCENARIO" \
  --workspace "$WS" --shots "$SHOTS" <<'EOF'
ready 30000
shot smoke-01-boot
expect Ask me anything
send create smoke.txt
wait Permission required @30000
shot smoke-02-permission
type r
wait SMOKE-DONE @30000
shot smoke-03-approved
quit
EOF

grep -q 'written by the smoke test' "$WS/smoke.txt"
echo "smoke: OK — $WS/smoke.txt written, screens in $SHOTS"
