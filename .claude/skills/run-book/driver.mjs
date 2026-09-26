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
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
// `--record <file>`: every PTY chunk with its arrival time, as JSON, for
// record-gif.mjs to replay into an animated GIF.
const RECORD_FILE = opt('record', null);
// Forwarded to the mock: the pause before each streamed delta (see mock-provider.mjs).
const CHUNK_DELAY_MS = opt('chunk-delay-ms', null);
// Leave the startup splash on: skip the workspace settings.json that turns it off.
const STARTUP_ANIMATION = flag('startup-animation');

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
  // Pass-through for the mock's own flags: `--mock-usage-from-estimate` etc.
  if (process.argv.includes('--mock-usage-from-estimate')) args.push('--usage-from-estimate');
  if (CHUNK_DELAY_MS) args.push('--chunk-delay-ms', CHUNK_DELAY_MS);
  mockProc = procSpawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => {
    const timer = setTimeout(
      () =>
        rej(
          new Error(
            `mock provider did not become ready on port ${MOCK_PORT} — ` +
              `if it says EADDRINUSE above, another process holds the port — ` +
              `pass --mock-port <other>, and never kill mocks by name: on a shared ` +
              `machine they belong to other runs`,
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
// `--startup-animation` keeps it, for driving the splash itself.
if (!STARTUP_ANIMATION) {
  mkdirSync(join(WORKSPACE, '.book'), { recursive: true });
  writeFileSync(
    join(WORKSPACE, '.book', 'settings.json'),
    JSON.stringify({ ui: { startupAnimation: false } }, null, 2),
  );
}

const env = {
  ...process.env,
  // Ink drops intermediate frames when it thinks it is in CI; this child is a
  // real interactive PTY and we need every frame.
  CI: 'false',
  CONTINUOUS_INTEGRATION: 'false',
  HOME: BOOK_HOME,
  // Windows resolves the home directory from USERPROFILE, not HOME.
  USERPROFILE: BOOK_HOME,
  BOOK_HOME: join(BOOK_HOME, '.book'),
  // Book's loadConfig throws without an API key even for `doctor`, so always set one.
  BOOK_API_KEY: process.env.BOOK_API_KEY ?? 'mock-key',
};
if (USE_MOCK) {
  env.BOOK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  env.BOOK_PROVIDER = 'openai';
  env.BOOK_MODEL = process.env.BOOK_MODEL ?? 'mock-model';
  env.BOOK_API_KEY = 'mock-key';
  // The Go build (--bin) reads the BOOKGO_* names and its own home directory.
  env.BOOKGO_BASE_URL = env.BOOK_BASE_URL;
  env.BOOKGO_PROVIDER = 'openai';
  env.BOOKGO_MODEL = env.BOOK_MODEL;
  env.BOOKGO_API_KEY = 'mock-key';
  env.BOOKGO_HOME = join(BOOK_HOME, '.bookgo');
}

const extraArgs = (() => {
  const i = argv.indexOf('--');
  return i === -1 ? [] : argv.slice(i + 1);
})();

// --bin <path> drives a different executable (e.g. the Go build, bin/book.exe)
// instead of node dist/index.js; the same flags are passed through.
const BIN = opt('bin', null);
// `--sessions` keeps session persistence on, so a pre-seeded
// `<book-home>/.book/sessions/*.jsonl` shows up in /resume and on the title page.
const PERSISTENCE = flag('sessions') ? [] : ['--no-session-persistence'];
const pty = BIN
  ? ptySpawn(BIN, ['--workspace', WORKSPACE, ...PERSISTENCE, ...extraArgs], {
      cwd: WORKSPACE, cols: COLS, rows: ROWS, env, name: 'xterm-256color',
    })
  : ptySpawn(
      process.execPath,
      [DIST_INDEX, '--workspace', WORKSPACE, ...PERSISTENCE, ...extraArgs],
      { cwd: WORKSPACE, cols: COLS, rows: ROWS, env, name: 'xterm-256color' },
    );
const recordStart = Date.now();
const recorded = [];
pty.onData((d) => {
  raw += d;
  if (RECORD_FILE) recorded.push([Date.now() - recordStart, d]);
});
pty.onExit((e) => {
  exited = true;
  exitCode = e.exitCode;
});

let cols = COLS;
let rows = ROWS;

async function screen() {
  // convertEol turns a bare LF into CRLF; Bubble Tea moves the cursor with bare
  // LFs (column kept), so the Go build must be replayed without it.
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: !BIN });
  try {
    await new Promise((res) => term.write(raw, res));
    return Array.from({ length: rows }, (_, i) =>
      (term.buffer.active.getLine(i)?.translateToString(true) ?? '').trimEnd(),
    );
  } finally {
    term.dispose();
  }
}

// xterm's 256-colour palette: 16 ANSI colours, a 6x6x6 cube, then 24 greys.
const ANSI16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
function paletteColor(i) {
  if (i < 16) return ANSI16[i];
  if (i < 232) {
    const n = i - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function cellColor(cell, fg) {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const v = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${v.toString(16).padStart(6, '0')}`;
  return paletteColor(v);
}
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function blockElementStyle(ch, fg, bg) {
  // A rule is a solid strip sized in pixels, not a gradient with 1px stops:
  // at a fractional device scale those stops round away and the rule vanishes.
  const strip = (w, h, x, y) =>
    `background:${bg} linear-gradient(${fg},${fg}) no-repeat ${x} ${y}/${w} ${h}`;
  switch (ch) {
    case '█': return `background:${fg}`;
    case '▀': return `background:linear-gradient(${fg} 50%,${bg} 50%)`;
    case '▄': return `background:linear-gradient(${bg} 50%,${fg} 50%)`;
    case '▌': return `background:linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case '▐': return `background:linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case '│': return strip('1px', '100%', '50%', '0');
    case '─': return strip('100%', '1px', '0', '50%');
    case '━': return strip('100%', '2px', '0', '50%');
    default: return null;
  }
}

// The screen as HTML with colours and attributes kept: a text shot cannot show
// whether a design reads well, and PTY bytes cannot be looked at.
async function screenHtml() {
  const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: !BIN });
  const DEFAULT_FG = '#d4d4d4';
  const DEFAULT_BG = '#0c0c0c';
  try {
    await new Promise((res) => term.write(raw, res));
    const out = [];
    const cell = term.buffer.active.getNullCell();
    for (let y = 0; y < rows; y++) {
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + y);
      let html = '';
      for (let x = 0; x < cols; x++) {
        if (!line) break;
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        let fg = cellColor(cell, true) ?? DEFAULT_FG;
        let bg = cellColor(cell, false);
        if (cell.isInverse()) [fg, bg] = [bg ?? DEFAULT_BG, fg];
        const style = [`color:${fg}`];
        if (bg) style.push(`background:${bg}`);
        if (cell.isBold()) style.push('font-weight:700');
        if (cell.isDim()) style.push('opacity:.55');
        if (cell.isItalic()) style.push('font-style:italic');
        if (cell.isUnderline()) style.push('text-decoration:underline');
        const chars = cell.getChars() || ' ';
        const block = blockElementStyle(chars, fg, bg ?? 'transparent');
        if (block) {
          // Terminals draw block elements and rules edge to edge; a font glyph
          // leaves seams between rows that are not there on a real screen.
          html += `<span class="b" style="${block}"></span>`;
          continue;
        }
        const wide = cell.getWidth() === 2 ? ' class="w"' : '';
        html += `<span${wide} style="${style.join(';')}">${escapeHtml(chars)}</span>`;
      }
      out.push(`<div class="r">${html || ' '}</div>`);
    }
    return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:${DEFAULT_BG};padding:14px}
.t{font:15px/18px "Cascadia Mono","Cascadia Code",Consolas,monospace;white-space:pre}
.r{height:18px;overflow:hidden}.w{display:inline-block;width:2ch}
.b{display:inline-block;width:1ch;height:18px;vertical-align:top}
</style><div class="t">${out.join('')}</div>`;
  } finally {
    term.dispose();
  }
}

// Headless Edge (always present on Windows 11) turns the HTML shot into a PNG.
function htmlToPng(htmlPath, pngPath) {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) return Promise.resolve(false);
  const width = Math.ceil(cols * 9.05 + 28);
  const height = rows * 18 + 28;
  const profile = mkdtempSync(join(tmpdir(), 'book-shot-profile-'));
  return new Promise((res) => {
    const child = procSpawn(
      exe,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--disable-lcd-text',
        `--user-data-dir=${profile}`,
        `--screenshot=${resolve(pngPath)}`,
        `--window-size=${width},${height}`,
        `file:///${resolve(htmlPath).replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('exit', () => {
      rmSync(profile, { recursive: true, force: true });
      res(true);
    });
    child.on('error', () => res(false));
  });
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
  'ctrl-e': '\x05',
  'ctrl-j': '\x0a',
  'ctrl-t': '\x14',
  'ctrl-u': '\x15',
  home: '\x1b[H',
  end: '\x1b[F',
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

async function flushAndExit(code) {
  process.exitCode = code;
  if (process.stdout._handle?.setBlocking) {
    try {
      process.stdout._handle.setBlocking(true);
    } catch {
      /* ignore */
    }
  }
  if (process.stderr._handle?.setBlocking) {
    try {
      process.stderr._handle.setBlocking(true);
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => {
    let remaining = 2;
    const finish = () => {
      if (--remaining <= 0) resolve();
    };
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    try {
      if (process.stdout.writable) {
        process.stdout.write('', finish);
      } else {
        finish();
      }
    } catch {
      finish();
    }
    try {
      if (process.stderr.writable) {
        process.stderr.write('', finish);
      } else {
        finish();
      }
    } catch {
      finish();
    }
  });
  process.exit(code);
}

async function fail(msg) {
  console.error(`\n[driver] FAIL: ${msg}`);
  console.error('[driver] last screen:\n' + (await screen()).join('\n'));
  await cleanup();
  await flushAndExit(1);
}

let ptyKilled = false;
function releasePty() {
  if (ptyKilled) return;
  ptyKilled = true;
  try {
    pty.kill();
  } catch {
    /* already gone */
  }
}

async function cleanup() {
  if (!exited) {
    releasePty();
    for (let i = 0; i < 40 && !exited; i++) await sleep(50);
  }
  releasePty();
  mockProc?.kill();
  if (RECORD_FILE) {
    writeFileSync(RECORD_FILE, JSON.stringify({ cols, rows, chunks: recorded }));
    console.log(`[driver] record -> ${RECORD_FILE}`);
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

// A signal skips cleanup(), and the mock would outlive the driver holding its port. Kill
// that one child — the only mock this driver may kill; others belong to other runs. (On
// Windows only a console Ctrl-C arrives as SIGINT; a kill there is TerminateProcess.)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    releasePty();
    mockProc?.kill();
    process.exit(1);
  });
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
        if (!new RegExp(rest).test(text))
          await fail(`expect ${JSON.stringify(rest)} not on screen`);
        console.log(`[driver] expect ok: ${rest}`);
        break;
      }
      case 'ready': {
        // The "Ask me anything" placeholder renders BEFORE Ink's stdin handler
        // is live — keystrokes sent in the first ~half second are swallowed.
        // Wait for the placeholder, then settle.
        // A narrow composer shortens the placeholder to `Ask...`, so match the
        // prompt glyph in front of it too.
        const ok = await waitFor('Ask me anything|[›>¶] Ask', Number(rest || DEFAULT_TIMEOUT), 'screen');
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
      case 'status':
        // Whether the TUI process is still running, without sending it a key.
        console.log(`[driver] status exited=${exited} code=${exitCode} at=${new Date().toISOString()}`);
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
      case 'shotpng': {
        // A colour screenshot: `<name>.html` always, `<name>.png` when a
        // Chromium-family browser is installed to render it headlessly.
        const name = rest || `shot-${Date.now()}`;
        const htmlPath = join(SHOT_DIR, `${name}.html`);
        const pngPath = join(SHOT_DIR, `${name}.png`);
        writeFileSync(htmlPath, await screenHtml());
        const ok = await htmlToPng(htmlPath, pngPath);
        console.log(`[driver] shotpng -> ${ok ? pngPath : htmlPath}`);
        break;
      }
      case 'raw':
        console.log(stripAnsi(raw).slice(-4000));
        break;
      case 'rawbytes':
        // Escapes kept (JSON-encoded): the only faithful record of what the
        // renderer emitted, when the xterm replay looks wrong.
        console.log(JSON.stringify(raw.slice(-Number(rest || '3000'))));
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

run()
  .then(() => flushAndExit(0))
  .catch(async (e) => {
    console.error('[driver] crashed:', e);
    await cleanup();
    await flushAndExit(1);
  });
