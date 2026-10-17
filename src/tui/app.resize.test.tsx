import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, type Instance } from 'ink';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadInkFlushSync, type InkFlushSync } from '../cli/ink-renderer.js';
import { SessionStore } from '../session/store.js';
import { defaultConfig } from '../test/fixtures.js';
import { displayWidth } from './components/word-wrap.js';

/**
 * #538. After a terminal resize the first frame, which Ink's own `resized()` draws in the same tick
 * as the `resize` event, must already be laid out at the new width, and the forced redraw (wipe and
 * full repaint) must paint that new layout, never the one from before the size change.
 *
 * These drive the real Ink renderer on a fake TTY stdout, the very emitter Ink registers `resized`
 * on: ink-testing-library's stdout is not a TTY, so Ink would never listen for its resizes. Once
 * the app is up, `setTimeout` and `clearTimeout` are faked, so the redraw debounce runs only when a
 * test advances it; `setImmediate`, which Ink's repaint yields to, stays real.
 */

vi.mock('../agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (_config: unknown, _registry: unknown, _message: string, history) => {
    return history;
  }),
}));
vi.mock('../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));
vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => ({
    list: async () => [],
    listPendingCompletions: async () => [],
    subscribe: () => () => {},
    setInteractivePermissions: () => {},
    send: () => {},
    stop: () => {},
    apply: () => {},
    get: () => {},
  }),
}));

import { App } from './app.js';

/** The redraw debounce in `app.tsx`, and one millisecond past it. */
const PAST_REDRAW_DEBOUNCE_MS = 51;

// Real Ink renders on timers, outside act(), as the TUI does.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironmentBefore = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
let flushSync: InkFlushSync | undefined;

beforeAll(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  flushSync = await loadInkFlushSync();
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = actEnvironmentBefore;
});

/** A TTY stdout that keeps every write, and resizes the way SIGWINCH does. */
class FakeStdout extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write = (data: string | Uint8Array, ...rest: unknown[]): boolean => {
    this.frames.push(String(data));
    // Ink's repaint waits for a write's callback before it reports the frame flushed.
    const done = rest.find((argument) => typeof argument === 'function') as
      (() => void) | undefined;
    done?.();
    return true;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): null => null;
}

const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*\x07/g;

function rowsOf(frame: string): string[] {
  return frame.replace(ANSI, '').split('\n');
}

/** The longest run of the input bar's rule character in a frame: the rule's width. */
function ruleWidth(frame: string): number {
  return Math.max(
    0,
    ...rowsOf(frame)
      .map((row) => (row.match(/─+/g) ?? []).map((run) => run.length))
      .flat(),
  );
}

function widestRow(frame: string): number {
  return Math.max(0, ...rowsOf(frame).map((row) => displayWidth(row)));
}

/** A whole frame Ink wrote in debug mode (it writes each frame in one piece), not an escape. */
function isFrame(write: string): boolean {
  return write.includes('─');
}

/** One turn of the event loop, through `setImmediate`, which the fake timers leave real. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Turns the event loop until `condition` holds, failing after `deadlineMs` of wall time. */
async function until(condition: () => boolean, what: string, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

function useFakeTimeouts(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

const roots: string[] = [];
const apps: Instance[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) {
    app.unmount();
    app.cleanup();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Wipe = () => void | Promise<void>;

interface Launched {
  stdout: FakeStdout;
  /** The rule width each forced redraw found in the last frame the tree had committed. */
  redrawRuleWidths: number[];
  /** Sets the new size and emits `resize`; returns the index of the first write after it. */
  resize: (columns: number, rows: number) => number;
  /** Renders the app again with a new `redrawViewport`, which re-subscribes its resize effect. */
  rerender: (wipe?: Wipe) => void;
  /** Resolves once the last forced redraw has repainted and released the terminal. */
  redrawSettled: () => Promise<void>;
}

async function launch(columns: number, rows: number, wipe?: Wipe): Promise<Launched> {
  const root = mkdtempSync(join(tmpdir(), 'book-resize-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new SessionStore(join(root, 'sessions'));
  const sessionId = store.create({ cwd: workspace });
  const loaded = store.load(sessionId);
  const config = defaultConfig({ workspace });
  config.settings.ui.startupAnimation = false;
  config.accessibility = { screenReader: false, reducedMotion: true };
  const stdout = new FakeStdout(columns, rows);
  const redrawRuleWidths: number[] = [];
  let writesAtLastWipe = 0;
  // Each call makes a new function, so a rerender hands App a new `redrawViewport`.
  const recording =
    (inner?: Wipe): Wipe =>
    () => {
      redrawRuleWidths.push(ruleWidth(stdout.frames.filter(isFrame).at(-1) ?? ''));
      writesAtLastWipe = stdout.frames.length;
      return inner?.();
    };
  const element = (redraw: Wipe) => (
    <App
      config={config}
      redrawViewport={redraw}
      flushSync={flushSync}
      session={{
        sessionId,
        history: loaded.contextHistory,
        transcript: loaded.transcript,
        contextHistory: loaded.contextHistory,
        compactBoundaries: loaded.compactBoundaries,
        rewindTargets: loaded.rewindTargets,
        activeEventIds: loaded.activeEventIds,
        source: 'startup',
        persisted: true,
        created: true,
        store,
        timelineStore: store,
      }}
    />
  );
  const app = render(element(recording(wipe)), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
    // Every frame is written whole and unthrottled, so the first one after a resize is readable.
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  apps.push(app);
  // Up: the composer is drawn, and App's listener has joined Ink's own on `resize`.
  await until(
    () =>
      stdout.frames.some((frame) => isFrame(frame) && frame.includes('Ask me anything')) &&
      stdout.listenerCount('resize') >= 2,
    'the first frame and the resize listeners',
  );
  return {
    stdout,
    redrawRuleWidths,
    resize: (nextColumns, nextRows) => {
      const at = stdout.frames.length;
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit('resize');
      return at;
    },
    rerender: (nextWipe) => app.rerender(element(recording(nextWipe))),
    redrawSettled: async () => {
      // The repaint writes a frame after the wipe; the in-flight flag clears a turn later.
      await until(() => stdout.frames.length > writesAtLastWipe, 'the repaint after the wipe');
      for (let turn = 0; turn < 3; turn++) await tick();
    },
  };
}

/** The first frame written at or after `at`, read with no await since the emit. */
function firstFrameFrom(stdout: FakeStdout, at: number): string {
  const frame = stdout.frames.slice(at).find(isFrame);
  expect(frame, 'Ink drew no frame in the tick of the resize').toBeDefined();
  return frame!;
}

function marginOf(stdout: FakeStdout, columns: number): number {
  return columns - ruleWidth(stdout.frames.filter(isFrame).at(-1)!);
}

describe('App on a terminal resize (#538)', () => {
  it('confirms the fake stdout is the emitter Ink draws a resized frame from', async () => {
    const { stdout, resize } = await launch(152, 39);
    expect(stdout.listenerCount('resize')).toBeGreaterThanOrEqual(2);
    const at = resize(73, 39);
    expect(stdout.frames.slice(at).some(isFrame)).toBe(true);
  });

  it('lays out the first frame after each resize at the new width, then redraws it once', async () => {
    const { stdout, redrawRuleWidths, resize, redrawSettled } = await launch(152, 39);
    // The rule's margin inside the terminal, so each size's rule width follows from it.
    const margin = marginOf(stdout, 152);
    expect(widestRow(stdout.frames.filter(isFrame).at(-1)!)).toBeLessThanOrEqual(152);
    useFakeTimeouts();

    const steps: [number, number][] = [
      [73, 39],
      [80, 30],
      [73, 30],
    ];
    for (const [columns, rows] of steps) {
      const at = resize(columns, rows);
      // No await since the emit: Ink's resized() has drawn in the same tick.
      const first = firstFrameFrom(stdout, at);
      const context = `${columns}x${rows} first frame:\n${rowsOf(first).join('\n')}`;
      expect(ruleWidth(first), context).toBe(columns - margin);
      expect(widestRow(first), context).toBeLessThanOrEqual(columns);

      const redrawsBefore = redrawRuleWidths.length;
      await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
      // One forced redraw, and the tree it repainted had already committed the new width.
      expect(redrawRuleWidths.slice(redrawsBefore), `${columns}x${rows}`).toEqual([
        columns - margin,
      ]);
      await redrawSettled();
    }
  });

  it('redraws once at the final size after a burst of resizes', async () => {
    const { stdout, redrawRuleWidths, resize } = await launch(152, 39);
    const margin = marginOf(stdout, 152);
    useFakeTimeouts();
    for (const columns of [120, 100, 90, 73]) {
      const at = resize(columns, 39);
      expect(ruleWidth(firstFrameFrom(stdout, at)), `${columns} columns`).toBe(columns - margin);
      // Inside the debounce: each resize restarts it.
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(redrawRuleWidths).toEqual([]);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(redrawRuleWidths).toEqual([73 - margin]);
  });

  it('does not redraw for a resize event that leaves the size unchanged', async () => {
    const { redrawRuleWidths, resize } = await launch(100, 30);
    useFakeTimeouts();
    resize(100, 30);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(redrawRuleWidths).toEqual([]);
  });

  it('keeps a redraw owed across a re-subscription of the resize effect', async () => {
    const { stdout, redrawRuleWidths, resize, rerender, redrawSettled } = await launch(152, 39);
    const margin = marginOf(stdout, 152);
    useFakeTimeouts();
    resize(73, 39);
    // A new redrawViewport inside the debounce: the effect's cleanup clears the pending timer.
    const ran: string[] = [];
    rerender(() => {
      ran.push('new');
    });
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(ran).toEqual(['new']);
    expect(redrawRuleWidths).toEqual([73 - margin]);
    await redrawSettled();
    // Paid: a later event that leaves the size alone owes nothing.
    resize(73, 39);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(redrawRuleWidths).toEqual([73 - margin]);
  });

  it('queues one trailing redraw for every call made while a redraw is in flight', async () => {
    // Ink pauses input while a redraw holds the terminal, so a Ctrl+L cannot land mid-redraw; the
    // resize debounce can, and it calls the same redrawViewport.
    const order: string[] = [];
    let release = () => {};
    let wipes = 0;
    const wipe = () => {
      wipes++;
      order.push(`wipe ${wipes}`);
      if (wipes > 1) return;
      return new Promise<void>((resolve) => {
        release = () => {
          order.push('wipe 1 done');
          resolve();
        };
      });
    };
    const { stdout, redrawRuleWidths, resize, redrawSettled } = await launch(152, 39, wipe);
    const margin = marginOf(stdout, 152);
    useFakeTimeouts();
    resize(73, 39);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(order).toEqual(['wipe 1']);
    // Two more debounced redraws come due while the first still holds the terminal.
    resize(80, 39);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    resize(90, 39);
    await vi.advanceTimersByTimeAsync(PAST_REDRAW_DEBOUNCE_MS);
    expect(order).toEqual(['wipe 1']);

    release();
    await until(() => order.length === 3, 'the trailing wipe');
    await redrawSettled();
    // Exactly one more wipe, after the first finished, of the layout committed by then.
    expect(order).toEqual(['wipe 1', 'wipe 1 done', 'wipe 2']);
    expect(redrawRuleWidths).toEqual([73 - margin, 90 - margin]);
  });
});
