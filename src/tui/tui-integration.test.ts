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
 * NOTE: These tests use Windows ConPTY on Windows and the native Unix PTY
 * elsewhere. Keep them sequential because parallel ConPTY sessions can emit
 * non-fatal "AttachConsole failed" helper errors and interfere with each other.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node-pty';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST_INDEX = join(__dirname, '..', '..', 'dist', 'index.js');
const PROJECT_ROOT = join(__dirname, '..', '..');
const IS_WINDOWS = process.platform === 'win32';
const HAS_API_KEY = !!process.env.BOOK_API_KEY;

function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\][^\x07]*\x07/g, '') // OSC sequences (terminal title)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ''); // CSI sequences
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function submitInteractive(session: TuiSession, text: string): Promise<void> {
  session.submit(text);
}

// ---------------------------------------------------------------------------
// PTY session wrapper
// ---------------------------------------------------------------------------

interface TuiSession {
  read(): string;
  readRaw(): string;
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  submit(text: string): void;
  sendKey(seq: string): void;
  resize(columns: number, rows: number): void;
  waitForExit(timeoutMs?: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * Start a TUI and wait until the initial render is visible (detected by
 * the presence of the "Ask me anything" placeholder in the input bar).
 */
async function startAndWait(extraEnv: Record<string, string> = {}): Promise<TuiSession> {
  const testRoot = mkdtempSync(join(tmpdir(), 'book-tui-'));
  const env = {
    ...process.env,
    // Ink suppresses intermediate frames in CI, but this child is an interactive PTY.
    CI: 'false',
    CONTINUOUS_INTEGRATION: 'false',
    HOME: testRoot,
    USERPROFILE: testRoot,
    BOOK_API_KEY: process.env.BOOK_API_KEY ?? 'sk-test-placeholder',
    ...extraEnv,
  };
  const nodePath = process.execPath;
  const pty = spawn(nodePath, [DIST_INDEX, '--workspace', testRoot, '--no-session-persistence'], {
    cwd: PROJECT_ROOT,
    cols: 120,
    rows: 40,
    env,
    name: 'xterm-256color',
    useConpty: IS_WINDOWS,
  });

  let output = '';
  const disposable = pty.onData((data: string) => {
    output += data;
  });
  let exited = false;
  let processExitCode: number | undefined;
  let resolveExit: ((exitCode: number) => void) | undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const exitDisposable = pty.onExit((event) => {
    exited = true;
    processExitCode = event.exitCode;
    resolveExit?.(event.exitCode);
  });

  async function waitForExit(timeoutMs = 5000): Promise<number> {
    if (exited) return processExitCode ?? -1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      exitPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`TUI did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  const session: TuiSession = {
    read() {
      return stripAnsi(output);
    },
    readRaw() {
      return output;
    },
    async waitFor(pattern: string | RegExp, timeoutMs = 15_000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const text = stripAnsi(output);
        if (typeof pattern === 'string') {
          if (text.includes(pattern)) return text;
        } else {
          pattern.lastIndex = 0;
          if (pattern.test(text)) return text;
        }
        await sleep(150);
      }
      const rendered = stripAnsi(output);
      throw new Error(
        `Timed out waiting for ${String(pattern)} after ${timeoutMs}ms. Last output:\n${rendered.slice(-4000)}`,
      );
    },
    submit(text: string) {
      pty.write(text);
      setTimeout(() => pty.write('\r'), 50);
    },
    sendKey(seq: string) {
      pty.write(seq);
    },
    resize(columns: number, rows: number) {
      pty.resize(columns, rows);
    },
    waitForExit,
    async close() {
      if (!exited) {
        try {
          // node-pty's ConPTY kill helper races with short-lived test sessions on Windows.
          if (IS_WINDOWS) process.kill(pty.pid);
          else pty.kill();
          await waitForExit();
        } catch {
          pty.kill();
          await waitForExit().catch(() => {});
        }
      }
      try {
        disposable.dispose();
      } catch {
        /* */
      }
      try {
        exitDisposable.dispose();
      } catch {
        /* */
      }
      rmSync(testRoot, { recursive: true, force: true });
    },
  };

  // Wait for the TUI to fully render (input bar placeholder visible).
  try {
    await session.waitFor('Ask me anything', 10_000);
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

// ANSI escape sequences for common keys.
const keys = {
  up: '\x1b[A',
  down: '\x1b[B',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
  ctrlHome: '\x1b[1;5H',
  ctrlEnd: '\x1b[1;5F',
  escape: '\x1b',
  ctrlS: '\x13',
  ctrlT: '\x14',
  ctrlL: '\x0c',
  ctrlSlash: '\x1f',
  altM: '\x1bm',
  wheelUp: '\x1b[<64;60;20M',
  wheelDown: '\x1b[<65;60;20M',
};

// ---------------------------------------------------------------------------
// Test lifecycle — sequential, with delay between spawns
// ---------------------------------------------------------------------------

let session: TuiSession | null = null;

afterEach(async () => {
  if (session) {
    await session.close();
    session = null;
  }
});

// ---------------------------------------------------------------------------
// Tests — Slash commands
// ---------------------------------------------------------------------------

describe('TUI slash commands', () => {
  it('/help shows the help panel with slash commands list', async () => {
    session = await startAndWait();
    await submitInteractive(session, '/help');
    await sleep(300);
    session.sendKey(keys.ctrlHome);
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
    await submitInteractive(session, '/help');
    await session.waitFor('Slash Commands', 5000);
    const beforeToggle = session.readRaw().length;
    await submitInteractive(session, '/help');
    await sleep(500);
    const output = stripAnsi(session.readRaw().slice(beforeToggle));
    const latestFrame = output.slice(output.lastIndexOf('╭ BOOK'));
    expect(latestFrame).toContain('Ask me anything');
    expect(latestFrame).not.toContain('Slash Commands');
  }, 20_000);

  it('/clear clears the conversation', async () => {
    session = await startAndWait();
    await submitInteractive(session, '/clear');
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('/theme dark shows dark theme', async () => {
    session = await startAndWait();
    await submitInteractive(session, '/theme dark');
    const output = await session.waitFor('Switched to dark theme', 5000);
    expect(output).toContain('saved as default');
  }, 20_000);

  it('/theme light shows light theme', async () => {
    session = await startAndWait();
    await submitInteractive(session, '/theme light');
    const output = await session.waitFor('Switched to light theme', 5000);
    expect(output).toContain('saved as default');
  }, 20_000);

  it('/exit exits the TUI gracefully', async () => {
    session = await startAndWait();
    await submitInteractive(session, '/exit');
    expect(await session.waitForExit(5000)).toBe(0);
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
    expect(output).toContain('ctx');
  }, 20_000);

  it('clears the visible viewport before redrawing after resize', async () => {
    session = await startAndWait();
    session.sendKey('RESIZE_MARKER');
    await session.waitFor('RESIZE_MARKER');

    const beforeResize = session.readRaw().length;
    session.resize(40, 24);
    await sleep(500);

    const resizeOutput = session.readRaw().slice(beforeResize);
    // PTY resize handling may insert cursor-position sequences between Ink's
    // home and clear commands, so assert the destructive clear itself.
    expect(resizeOutput).toContain('\x1b[2J');
    expect(stripAnsi(resizeOutput)).toContain('RESIZE_MARKER');
  }, 20_000);

  it('Up arrow key does not crash', async () => {
    session = await startAndWait();
    session.sendKey(keys.up);
    session.sendKey(keys.up);
    session.sendKey(keys.up);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Down arrow key does not crash', async () => {
    session = await startAndWait();
    session.sendKey(keys.down);
    session.sendKey(keys.down);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('PageUp / PageDown keys do not crash', async () => {
    session = await startAndWait();
    session.sendKey(keys.pageUp);
    session.sendKey(keys.pageDown);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('wheel events do not enter the prompt', async () => {
    session = await startAndWait();
    // Full-screen mode leaves mouse reporting disabled so terminal-native text
    // selection remains available. Explicit reports are still safely ignored.
    expect(session.readRaw()).toContain('\x1b[?1049h');
    expect(session.readRaw()).not.toContain('\x1b[?1000h');

    session.sendKey('MOUSE_DRAFT');
    await session.waitFor('MOUSE_DRAFT');
    session.sendKey(keys.wheelUp);
    session.sendKey(keys.wheelDown);
    await sleep(500);

    const output = session.read();
    expect(output).toContain('MOUSE_DRAFT');
    expect(output).not.toContain('[<64;60;20M');
    expect(output).not.toContain('[<65;60;20M');
  }, 20_000);

  it('Home / End keys do not crash', async () => {
    session = await startAndWait();
    session.sendKey(keys.home);
    session.sendKey(keys.end);
    await sleep(500);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Escape key does not crash when not streaming', async () => {
    session = await startAndWait();
    session.sendKey(keys.escape);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Ctrl+L redraws without crashing', async () => {
    session = await startAndWait();
    session.sendKey(keys.ctrlL);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  it('Alt+M cycles permission mode without crashing', async () => {
    session = await startAndWait();
    session.sendKey(keys.altM);
    await sleep(300);
    session.sendKey(keys.altM);
    await sleep(300);
    const output = session.read();
    expect(output).toContain('Ask me anything');
  }, 20_000);

  // Ctrl+/ is terminal-dependent: some PTYs report \x1f without enough
  // modifier information for Ink to distinguish the shortcut.
  it.skipIf(!process.env.BOOK_TUI_CTRL_SLASH_TEST)(
    'Ctrl+/ shows keyboard shortcuts reference',
    async () => {
      session = await startAndWait();
      session.sendKey(keys.ctrlSlash);
      await sleep(500);
      const output = session.read();
      expect(output).toContain('Keyboard Shortcuts');
      expect(output).toContain('Ctrl+T');
      expect(output).toContain('Esc');
    },
    20_000,
  );
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

  it('renders successful tool calls in the activity tree', async () => {
    session = await startAndWait();
    session.submit('Read the first line of package.json using the Read tool');
    const output = await session.waitFor(/✓/, 30_000);
    expect(output).toContain('✓');
    expect(output).toContain('Read');
  }, 50_000);

  it('/clear after streaming resets conversation', async () => {
    session = await startAndWait();
    session.submit('Say exactly: FIRST_MESSAGE');
    await session.waitFor('FIRST_MESSAGE', 30_000);
    await submitInteractive(session, '/clear');
    await sleep(500);
    session.submit('Say exactly: SECOND_MESSAGE');
    const output = await session.waitFor('SECOND_MESSAGE', 30_000);
    expect(output).toContain('SECOND_MESSAGE');
  }, 80_000);
});
