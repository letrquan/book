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
SHOTS="${BOOK_SMOKE_SHOTS:-/tmp/book-shots-$PORT}"

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "smoke: dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi

# The driver starts the mock and kills that one PID on every exit path, signals
# included. Nothing here kills a mock by name: on a shared machine the other
# mocks belong to other runs. Pick another port with BOOK_SMOKE_PORT.
#
# Probe the port before touching anything, so a port another process holds (another
# smoke run, a mock left behind) stops this run with a message and no side effects,
# before the `rm -rf` of a BOOK_SMOKE_WS below. (The driver would also fail fast, but
# only after that.)
probe=0
node -e "const s = require('net').createServer();
  s.once('error', (e) => { console.error(e.code || e.message); process.exit(e.code === 'EADDRINUSE' ? 3 : 2); });
  s.listen(Number(process.argv[1]), '127.0.0.1', () => s.close());" "$PORT" || probe=$?
if [ "$probe" -eq 3 ]; then
  echo "smoke: port $PORT is in use by another process; set BOOK_SMOKE_PORT" >&2
  exit 1
elif [ "$probe" -ne 0 ]; then
  echo "smoke: cannot probe port $PORT (node exited $probe); is node on PATH?" >&2
  exit 1
fi

# Every run gets a fresh directory for its workspace and scenario, so two runs never
# share files; it is removed when the run passes and kept, for a look, when it fails.
# A BOOK_SMOKE_WS of your own is used instead of the fresh workspace: it is emptied
# first and kept, so do not give two concurrent runs the same one.
RUN="$(mktemp -d /tmp/book-smoke-XXXXXX)"
SCENARIO="$RUN/scenario.json"
if [ -n "${BOOK_SMOKE_WS:-}" ]; then
  WS="$BOOK_SMOKE_WS"
  rm -rf "$WS"
  mkdir -p "$WS"
else
  WS="$RUN/ws"
  mkdir "$WS"
fi
git -C "$WS" init -q .

cat > "$SCENARIO" <<'JSON'
[
  { "tool": { "name": "Write", "arguments": { "file_path": "smoke.txt", "content": "written by the smoke test\n" } } },
  { "text": "Wrote the file. SMOKE-DONE" }
]
JSON

if ! node "$HERE/driver.mjs" --mock --mock-port "$PORT" --mock-script "$SCENARIO" \
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
then
  echo "smoke: FAILED — workspace $WS and scenario kept in $RUN, screens in $SHOTS" >&2
  exit 1
fi

if ! grep -q 'written by the smoke test' "$WS/smoke.txt"; then
  echo "smoke: FAILED — $WS/smoke.txt was not written; kept $RUN, screens in $SHOTS" >&2
  exit 1
fi
rm -rf "$RUN"
echo "smoke: OK — smoke.txt written, screens in $SHOTS"
