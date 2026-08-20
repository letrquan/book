#!/usr/bin/env node
/**
 * Book TUI driver — spawns the built CLI in a real PTY, feeds it keystrokes,
 * renders the terminal through xterm.js, and dumps text "screenshots".
 *
 * tmux is NOT available in this container, so this uses node-pty (already a
 * devDependency, used by src/tui/tui-integration.test.ts) instead. Commands are
 * read from stdin (heredoc) or from a file, one per line — batch, not a REPL,
 * so an agent can drive a whole flow with a single Bash call.
 *
 *   node .claude/skills/run-book/driver.mjs --mock <<'EOF'
 *   wait Ask me anything
 *   shot 01-boot
 *   send hello
 *   wait MOCK-OK
 *   shot 02-reply
 *   quit
 *   EOF
 *
 * Exit code is 0 only if every command succeeded; a failed `wait`/`expect`
 * prints the last screen and exits 1, so this doubles as a smoke test.
 */
import { spawn as ptySpawn } from 'node-pty';
import { spawn as procSpawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_ROOT = resolve(HERE, '..', '..', '..'); // .claude/skills/run-book -> repo root
const DIST_INDEX = join(UNIT_ROOT, 'dist', 'index.js');

// @xterm/headless lives in the repo's node_modules, not the skill dir.
const require = createRequire(join(UNIT_ROOT, 'package.json'));
const { Terminal } = require('@xterm/headless');

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
}

const COLS = Number(opt('cols', '120'));
const ROWS = Number(opt('rows', '40'));
const SHOT_DIR = opt('shots', '/tmp/book-shots');
const MOCK_PORT = Number(opt('mock-port', '8919'));
const MOCK_SCRIPT = opt('mock-script', null);
const USE_MOCK = flag('mock');
const SCRIPT_FILE = opt('script', null);
const DEFAULT_TIMEOUT = Number(opt('timeout', '20000'));
// Measured in this container: 300ms after the placeholder appears still loses
// keystrokes, 600ms does not. 2500ms is the comfortable margin.
const READY_SETTLE_MS = Number(opt('ready-settle', '2500'));
const SEND_GAP_MS = Number(opt('send-gap', '250'));

// A scratch workspace keeps the driver from touching the repo. Override with
// --workspace <path> when you want the TUI pointed at real code.
const explicitWorkspace = opt('workspace', null);
const scratch = explicitWorkspace ? null : mkdtempSync(join(tmpdir(), 'book-drive-'));
const WORKSPACE = explicitWorkspace ?? scratch;
// BOOK_HOME must be writable and separate from the user's real ~/.book.
const BOOK_HOME = opt('book-home', mkdtempSync(join(tmpdir(), 'book-home-')));

mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mock provider (optional)
// ---------------------------------------------------------------------------

let mockProc = null;
async function startMock() {
  const args = [join(HERE, 'mock-provider.mjs'), '--port', String(MOCK_PORT)];
  if (MOCK_SCRIPT) args.push('--script', MOCK_SCRIPT);
  mockProc = procSpawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    const timer = setTimeout(
      () =>
        rej(
          new Error(
            `mock provider did not become ready on port ${MOCK_PORT} — ` +
              `if it says EADDRINUSE above, a previous run is still listening ` +
              `(pkill -f mock-provider) or pass --mock-port <other>`,
          ),
        ),
      10000,
    );
    mockProc.stdout.on('data', (d) => {
      if (String(d).includes('MOCK-PROVIDER-READY')) {
        clearTimeout(timer);
        res();
      }
    });
  });
  console.log(`[driver] mock provider on http://127.0.0.1:${MOCK_PORT}/v1`);
}

// ---------------------------------------------------------------------------
// PTY session
// ---------------------------------------------------------------------------

let raw = '';
let exited = false;
let exitCode = null;

// The startup fire animation delays the first render past short waits.
mkdirSync(join(WORKSPACE, '.book'), { recursive: true });
writeFileSync(
  join(WORKSPACE, '.book', 'settings.json'),
  JSON.stringify({ ui: { startupAnimation: false } }, null, 2),
);

const env = {
  ...process.env,
  // Ink drops intermediate frames when it thinks it is in CI; this child is a
  // real interactive PTY and we need every frame.
  CI: 'false',
  CONTINUOUS_INTEGRATION: 'false',
  HOME: BOOK_HOME,
  BOOK_HOME: join(BOOK_HOME, '.book'),
  // Book's loadConfig throws without an API key even for `doctor`, so always set one.
  BOOK_API_KEY: process.env.BOOK_API_KEY ?? 'mock-key',
};
if (USE_MOCK) {
  env.BOOK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  env.BOOK_PROVIDER = 'openai';
  env.BOOK_MODEL = process.env.BOOK_MODEL ?? 'mock-model';
  env.BOOK_API_KEY = 'mock-key';
}

const extraArgs = (() => {
  const i = argv.indexOf('--');
  return i === -1 ? [] : argv.slice(i + 1);
})();

const pty = ptySpawn(
  process.execPath,
  [DIST_INDEX, '--workspace', WORKSPACE, '--no-session-persistence', ...extraArgs],
  { cwd: WORKSPACE, cols: COLS, rows: ROWS, env, name: 'xterm-256color' },
);
pty.onData((d) => {
  raw += d;
});
pty.onExit((e) => {
  exited = true;
  exitCode = e.exitCode;
});

let cols = COLS;
let rows = ROWS;

async function screen() {
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  try {
    await new Promise((res) => term.write(raw, res));
    return Array.from({ length: rows }, (_, i) =>
      (term.buffer.active.getLine(i)?.translateToString(true) ?? '').trimEnd(),
    );
  } finally {
    term.dispose();
  }
}

function stripAnsi(s) {
  return s.replace(/\x1B\][^\x07]*\x07/g, '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function waitFor(pattern, timeoutMs, source) {
  const re = new RegExp(pattern);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = source === 'raw' ? stripAnsi(raw) : (await screen()).join('\n');
    if (re.test(text)) return true;
    if (exited) break;
    await sleep(150);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-r': '\x12',
  'ctrl-l': '\x0c',
  'ctrl-o': '\x0f',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};

// ---------------------------------------------------------------------------
// Command loop
// ---------------------------------------------------------------------------

function readCommands() {
  const text = SCRIPT_FILE ? readFileSync(SCRIPT_FILE, 'utf8') : readFileSync(0, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function fail(msg) {
  console.error(`\n[driver] FAIL: ${msg}`);
  console.error('[driver] last screen:\n' + (await screen()).join('\n'));
  await cleanup();
  process.exit(1);
}

async function cleanup() {
  if (!exited) {
    try {
      pty.kill();
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40 && !exited; i++) await sleep(50);
  }
  mockProc?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

async function run() {
  if (USE_MOCK) await startMock();
  console.log(`[driver] workspace=${WORKSPACE} shots=${SHOT_DIR}`);

  const commands = readCommands();
  for (const line of commands) {
    const sp = line.indexOf(' ');
    const cmd = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1);

    switch (cmd) {
      case 'wait':
      case 'waitraw': {
        const m = rest.match(/^(.*?)(?:\s+@(\d+))?$/s);
        const pattern = m[1];
        const timeout = m[2] ? Number(m[2]) : DEFAULT_TIMEOUT;
        const ok = await waitFor(pattern, timeout, cmd === 'waitraw' ? 'raw' : 'screen');
        if (!ok) await fail(`wait ${JSON.stringify(pattern)} timed out after ${timeout}ms`);
        console.log(`[driver] wait ok: ${pattern}`);
        break;
      }
      case 'expect': {
        const text = (await screen()).join('\n');
        if (!new RegExp(rest).test(text)) await fail(`expect ${JSON.stringify(rest)} not on screen`);
        console.log(`[driver] expect ok: ${rest}`);
        break;
      }
      case 'ready': {
        // The "Ask me anything" placeholder renders BEFORE Ink's stdin handler
        // is live — keystrokes sent in the first ~half second are swallowed.
        // Wait for the placeholder, then settle.
        const ok = await waitFor('Ask me anything', Number(rest || DEFAULT_TIMEOUT), 'screen');
        if (!ok) await fail('TUI never rendered the input bar');
        await sleep(READY_SETTLE_MS);
        console.log('[driver] ready');
        break;
      }
      case 'send':
        // Text and \r must land in separate reads, or Book treats the chunk as
        // a multiline paste and inserts a newline instead of submitting.
        pty.write(rest);
        await sleep(SEND_GAP_MS);
        pty.write('\r');
        break;
      case 'type':
        pty.write(rest);
        break;
      case 'key': {
        for (const name of rest.split(/\s+/)) {
          const seq = KEYS[name.toLowerCase()];
          if (seq === undefined) await fail(`unknown key: ${name}`);
          pty.write(seq);
          await sleep(60);
        }
        break;
      }
      case 'sleep':
        await sleep(Number(rest || '500'));
        break;
      case 'resize':
        [cols, rows] = rest.split(/\s+/).map(Number);
        pty.resize(cols, rows);
        break;
      case 'screen':
        console.log('----- screen -----');
        console.log((await screen()).join('\n'));
        console.log('------------------');
        break;
      case 'shot': {
        const name = rest || `shot-${Date.now()}`;
        const path = join(SHOT_DIR, `${name}.txt`);
        writeFileSync(path, (await screen()).join('\n') + '\n');
        console.log(`[driver] shot -> ${path}`);
        break;
      }
      case 'raw':
        console.log(stripAnsi(raw).slice(-4000));
        break;
      case 'quit':
        pty.write('\x03');
        await sleep(200);
        pty.write('\x03');
        for (let i = 0; i < 60 && !exited; i++) await sleep(100);
        console.log(`[driver] exited=${exited} code=${exitCode}`);
        break;
      default:
        await fail(`unknown command: ${cmd}`);
    }
  }

  await cleanup();
  console.log('[driver] OK');
}

run().catch(async (e) => {
  console.error('[driver] crashed:', e);
  await cleanup();
  process.exit(1);
});
