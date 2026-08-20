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
WS="${BOOK_SMOKE_WS:-/tmp/book-smoke-ws}"
SHOTS="${BOOK_SMOKE_SHOTS:-/tmp/book-shots}"

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "smoke: dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi

# A stale mock from a previous run holds the port.
pkill -f 'mock[-]provider' 2>/dev/null || true
sleep 0.3

rm -rf "$WS"
mkdir -p "$WS"
git -C "$WS" init -q .

cat > /tmp/book-smoke-scenario.json <<'JSON'
[
  { "tool": { "name": "Write", "arguments": { "file_path": "smoke.txt", "content": "written by the smoke test\n" } } },
  { "text": "Wrote the file. SMOKE-DONE" }
]
JSON

node "$HERE/driver.mjs" --mock --mock-script /tmp/book-smoke-scenario.json \
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
