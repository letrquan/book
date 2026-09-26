#!/usr/bin/env bash
# Regenerates the README's media in docs/media/ from the real TUI, driven
# against the mock provider: the hero GIF, the title page, a permission prompt,
# and the add-provider wizard. Run it after a change that alters how any of
# them look.
#
#   bash .claude/skills/run-book/readme-media.sh
#
# Requires: npm run build (dist/), a built node-pty, and headless Edge or
# Chromium for record-gif.mjs. Nothing touches your real ~/.book: every run
# gets a throwaway workspace and BOOK_HOME.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="$ROOT/docs/media"
PORT="${BOOK_MEDIA_PORT:-8931}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/book-media-XXXXXX")"
TITLE="book — weather-api"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "readme-media: dist/index.js missing — run 'npm run build' first" >&2
  exit 1
fi
mkdir -p "$OUT"

# The demo project: a config loader whose empty TIMEOUT_MS turns the timeout off.
WS="$WORK/weather-api"
mkdir -p "$WS/src" "$WS/test"
cat > "$WS/package.json" <<'EOF'
{
  "name": "weather-api",
  "version": "1.4.0",
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.ts"
  }
}
EOF
cat > "$WS/src/config.ts" <<'EOF'
function num(raw: string | undefined, fallback: number): number {
  return Number(raw ?? fallback);
}

export interface Config {
  retries: number;
  timeoutMs: number;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return {
    retries: num(env.RETRIES, 3),
    timeoutMs: num(env.TIMEOUT_MS, 1000),
  };
}
EOF
cat > "$WS/src/client.ts" <<'EOF'
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);

export async function fetchForecast(city: string): Promise<unknown> {
  const signal = config.timeoutMs > 0 ? AbortSignal.timeout(config.timeoutMs) : undefined;
  const res = await fetch(`https://api.example.com/forecast?city=${city}`, { signal });
  return res.json();
}
EOF
cat > "$WS/test/config.test.ts" <<'EOF'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('uses the default timeout when TIMEOUT_MS is unset', () => {
  assert.equal(loadConfig({}).timeoutMs, 1000);
});

test('falls back to the default when TIMEOUT_MS is empty', () => {
  assert.equal(loadConfig({ TIMEOUT_MS: '' }).timeoutMs, 1000);
});

test('keeps an explicit timeout', () => {
  assert.equal(loadConfig({ TIMEOUT_MS: '2500' }).timeoutMs, 2500);
});
EOF
printf '.book/\nnode_modules/\n' > "$WS/.gitignore"
git -C "$WS" init -q -b main .
git -C "$WS" -c core.autocrlf=false add -A
git -C "$WS" -c user.name=demo -c user.email=demo@example.com commit -qm "weather-api"

# Reads are allowed up front, so the demo asks only before the edit and the command.
mkdir -p "$WORK/home/.book"
printf '{ "permissions": { "allow": ["Read(*)", "Grep(*)", "Glob(*)"] } }\n' \
  > "$WORK/home/.book/settings.json"

echo "readme-media: recording the hero session"
BOOK_MODEL=claude-sonnet-5 node "$HERE/driver.mjs" --mock --mock-port "$PORT" \
  --mock-script "$HERE/demo/hero.json" --chunk-delay-ms 30 \
  --workspace "$WS" --book-home "$WORK/home" --shots "$WORK/shots" --cols 100 --rows 30 \
  --record "$WORK/hero.rec.json" --script "$HERE/demo/hero-drive.txt" > "$WORK/hero.log"

GIF="$HERE/record-gif.mjs"
# Drawn at twice the size, so the text stays sharp on a high-density screen.
SCALE=(--scale 2)
node "$GIF" "$WORK/hero.rec.json" "$OUT/demo.gif" "${SCALE[@]}" --fps 12 --start-at "Ask me anything" \
  --until "client.ts intends" --after 3200 --max-hold 2800 --end-hold 4500 --title "$TITLE"
rm -f "$OUT/demo.last.png"
node "$GIF" "$WORK/hero.rec.json" "$OUT/title-page.png" "${SCALE[@]}" --until "Ask me anything" --after 1500 \
  --rows 3:30 --title "$TITLE"
node "$GIF" "$WORK/hero.rec.json" "$OUT/permission.png" "${SCALE[@]}" --until "Permission required" \
  --after 2000 --title "$TITLE"

echo "readme-media: recording the add-provider wizard"
mkdir -p "$WORK/home-wizard" "$WORK/wizard/weather-api"
# A fresh checkout of the same name: the hero session left its edit behind.
git clone -q "$WS" "$WORK/wizard/weather-api"
# No --mock: the wizard is the path a user without a provider takes.
env -u BOOK_API_KEY -u BOOK_BASE_URL -u BOOK_MODEL -u BOOK_PROVIDER node "$HERE/driver.mjs" \
  --workspace "$WORK/wizard/weather-api" --book-home "$WORK/home-wizard" --shots "$WORK/shots" --cols 100 --rows 26 \
  --record "$WORK/wizard.rec.json" --script "$HERE/demo/add-provider-drive.txt" > "$WORK/wizard.log"
node "$GIF" "$WORK/wizard.rec.json" "$OUT/add-provider.png" "${SCALE[@]}" --fps 20 --until "Step 9/9" \
  --after 200 --rows 9:21 --title "$TITLE"

ls -la "$OUT"
