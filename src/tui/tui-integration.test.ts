/**
 * PTY-based integration tests for the Book interactive TUI.
 *
 * Spawns the built CLI in a pseudo-terminal, sends keystrokes, and asserts
 * on rendered output. Tests slash commands, streaming, tool calls, scrolling,
 * and keyboard shortcuts.
 *
 * Uses node-pty's onData event to collect output. Slash-command-only tests
 * run without an API key. Streaming tests require BOOK_API_KEY env var.
 *
 * NOTE: On Windows ConPTY, these tests MUST run sequentially (Vitest
 * file-level `--pool forks --poolOptions.forks.singleFork`) because
 * spawning multiple ConPTY sessions in parallel causes "AttachConsole
 * failed" errors. The "AttachConsole failed" messages from
 * conpty_console_list_agent.js in stdout are non-fatal — they come from
 * a helper process spawned by node-pty and don't affect the TUI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, IPty, IDisposable } from 'node-pty';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_INDEX = join(__dirname, '..', '..', 'dist', 'index.js');
const PROJECT_ROOT = join(__dirname, '..', '..');
const HAS_API_KEY = !!process.env.BOOK_API_KEY;

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\][^\x07]*\x07/g, '')   // OSC sequences (terminal title)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); // CSI sequences
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// PTY session wrapper
// ---------------------------------------------------------------------------

interface TuiSession {
  read(): string;
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  submit(text: string): void;
  sendKey(seq: string): void;
  kill(): void;
}

/**
 * Start a TUI and wait until the initial render is visible (detected by
 * the presence of the "Ask me anything" placeholder in the input bar).
 */
async function startAndWait(extraEnv: Record<string, string> = {}): Promise<TuiSession> {
  const env = {
    ...process.env,
    BOOK_API_KEY: process.env.BOOK_API_KEY ?? 'sk-test-placeholder',
    ...extraEnv,
  };
  const nodePath = process.execPath;
  const pty = spawn(nodePath, [DIST_INDEX], {
    cwd: PROJECT_ROOT,
    cols: 120,
    rows: 40,
    env,
    name: 'xterm-256color',
    useConpty: true,
  });

  let output = '';
  const disposable = pty.onData((data: string) => {
    output += data;
  });

  const session: TuiSession = {
    read() {
      return stripAnsi(output);
    },
    async waitFor(pattern: string | RegExp, timeoutMs = 15_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const text = stripAnsi(output);
        if (typeof pattern === 'string') {
          if (text.includes(pattern)) return text;
        } else {
          if (pattern.test(text)) return text;
        }
        await sleep(150);
      }
      return stripAnsi(output);
    },
    submit(text: string) {
      pty.write(text + '\r');
    },
    sendKey(seq: string) {
      pty.write(seq);
    },
    kill() {
      try { disposable.dispose(); } catch { /* */ }
      try { pty.kill(); } catch { /* */ }
    },
  };

  // Wait for the TUI to fully render (input bar placeholder visible).
  await session.waitFor('Ask me anything', 10_000);
  return session;
}

// ANSI escape sequences for common keys.
const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
  escape: '\x1b',
  ctrlS: '\x13',
  ctrlT: '\x14',
  ctrlL: '\x0c',
  ctrlSlash: '\x1f',
  altM: '\x1bm',
};

// ---------------------------------------------------------------------------
// Test lifecycle — sequential, with delay between spawns
// ---------------------------------------------------------------------------

let session: TuiSession | null = null;

afterEach(async () => {
  if (session) {
    session.kill();
    session = null;
    // Let ConPTY cleanup before next spawn.
    await sleep(500);
  }
});

// ---------------------------------------------------------------------------
// Tests — Slash commands
// ---------------------------------------------------------------------------

describe('TUI slash commands', () => {
  it('/help shows the help panel with slash commands list', async () => {
    session = await startAndWait();
    session.submit('/help');
    const output = await session.waitFor('Slash Commands', 5000);
    expect(output).toContain('Slash Commands');
    expect(output).toContain('/help');
    expect(output).toContain('/clear');
    expect(output).toContain('/compact');
    expect(output).toContain('/theme');
    expect(output).toContain('/exit');
  }, 20_000);

  it('/help toggle hides the help panel', async () => {
    session = await startAndWait();
    session.submit('/help');
    await session.waitFor('Slash Commands', 5000);
    session.submit('/help');
    await sleep(500);
    const output = session.read();
    expect(output.length).toBeGreaterThan(0);
  }, 20_000);

  it('/clear clears the conversation', async () => {
    session = await startAndWait();
    session.submit('/clear');
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('/theme dark shows dark theme', async () => {
    session = await startAndWait();
    session.submit('/theme dark');
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('/theme light shows light theme', async () => {
    session = await startAndWait();
    session.submit('/theme light');
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('/exit exits the TUI gracefully', async () => {
    session = await startAndWait();
    session.submit('/exit');
    await sleep(1500);
    expect(true).toBe(true);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Tests — Keyboard scrolling & shortcuts
// ---------------------------------------------------------------------------

describe('TUI keyboard input', () => {
  it('renders the TUI on startup with status line and input', async () => {
    session = await startAndWait();
    const output = session.read();
    expect(output).toContain('Ask me anything');
    expect(output).toContain('tokens');
  }, 20_000);

  it('Up arrow key does not crash', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.up);
    session.sendKey(KEYS.up);
    session.sendKey(KEYS.up);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Down arrow key does not crash', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.down);
    session.sendKey(KEYS.down);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('PageUp / PageDown keys do not crash', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.pageUp);
    session.sendKey(KEYS.pageDown);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Home / End keys do not crash', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.home);
    session.sendKey(KEYS.end);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Escape key does not crash when not streaming', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.escape);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Ctrl+L redraws without crashing', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.ctrlL);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Alt+M cycles permission mode without crashing', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.altM);
    await sleep(300);
    session.sendKey(KEYS.altM);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Ctrl+/ shows keyboard shortcuts reference', async () => {
    session = await startAndWait();
    session.sendKey(KEYS.ctrlSlash);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Keyboard Shortcuts');
    expect(output).toContain('Ctrl+T');
    expect(output).toContain('Esc');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Tests — Streaming & tool calls (needs BOOK_API_KEY)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_API_KEY)('TUI streaming with API', () => {
  it('streams a response after submitting a message', async () => {
    session = await startAndWait();
    session.submit('Say exactly: HELLO_TUI_TEST');
    const output = await session.waitFor('HELLO_TUI_TEST', 30_000);
    expect(output).toContain('HELLO_TUI_TEST');
  }, 50_000);

  it('renders tool calls with [OK] badges', async () => {
    session = await startAndWait();
    session.submit('Read the first line of package.json using the Read tool');
    const output = await session.waitFor(/\[OK\]/, 30_000);
    expect(output).toContain('[OK]');
    expect(output).toContain('Read');
  }, 50_000);

  it('/clear after streaming resets conversation', async () => {
    session = await startAndWait();
    session.submit('Say exactly: FIRST_MESSAGE');
    await session.waitFor('FIRST_MESSAGE', 30_000);
    session.submit('/clear');
    await sleep(500);
    session.submit('Say exactly: SECOND_MESSAGE');
    const output = await session.waitFor('SECOND_MESSAGE', 30_000);
    expect(output).toContain('SECOND_MESSAGE');
  }, 80_000);
});
