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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { replayTerminalOutput } from './terminal-screen.js';

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
  await session.submit(text);
}

// ---------------------------------------------------------------------------
// PTY session wrapper
// ---------------------------------------------------------------------------

interface TuiSession {
  read(): string;
  readRaw(): string;
  readScreen(): Promise<string[]>;
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>;
  submit(text: string): Promise<void>;
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
  // The startup fire animation delays the input bar past waitFor timeouts on
  // loaded runners; these tests need a deterministic boot straight to the UI.
  mkdirSync(join(testRoot, '.book'), { recursive: true });
  writeFileSync(
    join(testRoot, '.book', 'settings.json'),
    JSON.stringify({ ui: { startupAnimation: false } }),
  );
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
  let terminalColumns = 120;
  let terminalRows = 40;
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

  async function waitForExit(timeoutMs = 10_000): Promise<number> {
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
    readScreen() {
      return replayTerminalOutput(output, { cols: terminalColumns, rows: terminalRows });
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
    async submit(text: string) {
      // The app must consume the typed text before Enter is written. When the
      // child is descheduled (routine on loaded CI runners, any platform),
      // both writes land in one stdin read; Ink's input parser only splits
      // chunks at escape bytes, so it delivers "text\r" as a single
      // paste-like keypress — `key.return` is never set and the editor drops
      // the trailing \r as a control byte, silently losing the submission.
      // The echoed draft ("› " + text, rendered by the input row and by a
      // highlighted command-menu row) is proof the text was read, so the
      // following \r arrives in its own chunk and parses as Enter.
      const echoStart = output.length;
      pty.write(text);
      const echo = '› ' + text;
      const start = Date.now();
      while (!stripAnsi(output.slice(echoStart)).includes(echo)) {
        if (Date.now() - start >= 10_000) {
          throw new Error(
            `Typed input was not echoed within 10000ms: ${JSON.stringify(text)}. Last output:\n${stripAnsi(output).slice(-4000)}`,
          );
        }
        await sleep(50);
      }
      pty.write('\r');
    },
    sendKey(seq: string) {
      pty.write(seq);
    },
    resize(columns: number, rows: number) {
      terminalColumns = columns;
      terminalRows = rows;
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
  ctrlU: '\x15',
  // SGR reports emitted by Book's button-event tracking mode.
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

  it('/review reports back instead of leaving the prompt silent', async () => {
    // The workspace is not a git repository, so target resolution fails fast.
    // That is enough to prove the wiring the TUI owns: the command is
    // dispatched, the host's output reaches the transcript, and the session
    // survives — a review used to be a fire-and-forget call that reported
    // nothing at all until it finished, if it ever did.
    session = await startAndWait();
    await submitInteractive(session, '/review');
    const output = await session.waitFor('review failed', 15_000);
    expect(output).toContain('review failed');
    // Reported in the transcript by the host, not thrown as a crash.
    expect(output).toContain('Ask me anything');
  }, 30_000);

  it('/help toggle hides the help panel', async () => {
    // Full-frame rendering makes the post-toggle terminal state directly assertable.
    session = await startAndWait({ BOOK_TUI_RENDERER: 'safe' });
    await submitInteractive(session, '/help');
    await session.waitFor('Slash Commands', 5000);
    const beforeToggle = session.readRaw().length;
    await submitInteractive(session, '/help');
    await sleep(500);
    const output = stripAnsi(session.readRaw().slice(beforeToggle));
    const latestFrame = output.slice(output.lastIndexOf('╭ BOOK'));
    // Incremental rendering does not rewrite the now-stable input row when
    // only the transcript changes.
    expect(latestFrame).toContain('╭ BOOK');
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
    // ConPTY can delay the final process-exit event on a loaded Windows runner.
    expect(await session.waitForExit(15_000)).toBe(0);
  }, 30_000);
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

    // The redraw is asynchronous (SIGWINCH → clear + repaint), so wait for the
    // clear-and-repaint bytes themselves instead of sampling at a fixed delay —
    // under CPU contention the child may not have processed the resize yet.
    // PTY resize handling may insert cursor-position sequences between Ink's
    // home and clear commands, so the observable is the destructive clear itself.
    const redrawDeadline = Date.now() + 8000;
    let resizeOutput = session.readRaw().slice(beforeResize);
    while (
      !(resizeOutput.includes('\x1b[2J') && stripAnsi(resizeOutput).includes('RESIZE_MARKER')) &&
      Date.now() < redrawDeadline
    ) {
      await sleep(100);
      resizeOutput = session.readRaw().slice(beforeResize);
    }
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

  it('mouse reports do not enter the prompt', async () => {
    session = await startAndWait();
    // Full-screen mode enables SGR button-event tracking for scrolling,
    // clicking, and drag-copy after clearing any stale terminal modes.
    expect(session.readRaw()).toContain('\x1b[?1049h');
    // Windows ConPTY consumes mouse-mode control sequences before onData.
    if (!IS_WINDOWS) {
      expect(session.readRaw()).toContain('\x1b[?1000l');
      expect(session.readRaw()).toContain('\x1b[?1002h');
      expect(session.readRaw()).toContain('\x1b[?1006h');
    }

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

  it.skipIf(IS_WINDOWS)(
    'keyboard scrolling reaches transcript history promptly',
    async () => {
      session = await startAndWait();
      await submitInteractive(session, '/help');
      await session.waitFor('Slash Commands', 5000);

      const startedAt = performance.now();
      session.sendKey(keys.ctrlU);
      // Incremental terminal writes may split or overwrite the final cell in the
      // captured byte stream even though the reconstructed screen has the full label.
      await session.waitFor('browsing histor', 8000);

      // A gross-regression guard, not a latency target: a PTY round-trip on a shared CI runner
      // routinely exceeds 500ms under load, which made this the single flakiest assertion in the
      // suite. Real rendering performance is gated by `npm run bench:ui` in the quality ratchet.
      expect(performance.now() - startedAt).toBeLessThan(3000);
    },
    20_000,
  );

  it.skipIf(IS_WINDOWS)(
    'safe rendering keeps the final input frame visible after deep scrolling',
    async () => {
      session = await startAndWait({ BOOK_TUI_RENDERER: 'safe' });
      await submitInteractive(session, '/help');
      await session.waitFor('Slash Commands', 5000);

      session.sendKey('INPUT_FOOTER_SENTINEL');
      await session.waitFor('INPUT_FOOTER_SENTINEL');
      // Pace the scroll steps instead of writing them in one tick. Ctrl+U is a
      // bare \x15 with no escape byte, and Ink's parser splits a chunk only at
      // escape bytes: when the child is descheduled (routine on loaded CI
      // runners) the whole burst lands in a single stdin read and parses as one
      // unknown 24-character keypress, so *no* scroll step happens and the
      // wait below expires with nothing to find. This is the same coalescing
      // the submit() helper above guards against.
      for (let index = 0; index < 24; index++) {
        session.sendKey(keys.ctrlU);
        await sleep(20);
      }
      // Wait bound only — this test asserts frame correctness below, not latency.
      await session.waitFor('browsing histor', 8000);

      // 'browsing histor' proves the first scroll step landed, but the safe
      // renderer still repaints a whole frame for each remaining queued step.
      // A screen replayed from a byte stream captured mid-repaint is torn
      // (sentinel row duplicated or the box half-drawn), so converge on the
      // settled final frame instead of sampling at a fixed delay: poll the
      // replayed screen until it satisfies the frame invariant, bounded by a
      // deadline. A real frame regression never converges and fails the same
      // assertions below on the last snapshot.
      const sentinelRows = (rows: string[]) =>
        rows
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes('INPUT_FOOTER_SENTINEL'));
      const isSettledFinalFrame = (rows: string[]): boolean => {
        const hits = sentinelRows(rows);
        if (hits.length !== 1) return false;
        const row = hits[0]!.index;
        return (
          (rows[row - 1]?.includes('╭') ?? false) &&
          hits[0]!.line.includes('│') &&
          (rows[row + 1]?.includes('╰') ?? false)
        );
      };
      const deadline = Date.now() + 4000;
      let screen = await session.readScreen();
      while (!isSettledFinalFrame(screen) && Date.now() < deadline) {
        await sleep(150);
        screen = await session.readScreen();
      }

      const inputRows = sentinelRows(screen);
      expect(inputRows).toHaveLength(1);

      const inputRow = inputRows[0]!.index;
      expect(screen[inputRow - 1]).toContain('╭');
      expect(screen[inputRow]).toContain('│');
      expect(screen[inputRow + 1]).toContain('╰');
    },
    20_000,
  );

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
    await session.submit('Say exactly: HELLO_TUI_TEST');
    const output = await session.waitFor('HELLO_TUI_TEST', 30_000);
    expect(output).toContain('HELLO_TUI_TEST');
  }, 50_000);

  it('renders successful tool calls in the activity tree', async () => {
    session = await startAndWait();
    await session.submit('Read the first line of package.json using the Read tool');
    const output = await session.waitFor(/✓/, 30_000);
    expect(output).toContain('✓');
    expect(output).toContain('Read');
  }, 50_000);

  it('/clear after streaming resets conversation', async () => {
    session = await startAndWait();
    await session.submit('Say exactly: FIRST_MESSAGE');
    await session.waitFor('FIRST_MESSAGE', 30_000);
    await submitInteractive(session, '/clear');
    await sleep(500);
    await session.submit('Say exactly: SECOND_MESSAGE');
    const output = await session.waitFor('SECOND_MESSAGE', 30_000);
    expect(output).toContain('SECOND_MESSAGE');
  }, 80_000);
});
