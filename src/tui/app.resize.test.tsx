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
 * on: ink-testing-library's stdout is not a TTY, so Ink would never listen for its resizes.
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

/** The redraw debounce in `app.tsx`, with room for a slow runner. */
const PAST_REDRAW_DEBOUNCE_MS = 150;

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
  write = (data: string | Uint8Array): boolean => {
    this.frames.push(String(data));
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const roots: string[] = [];
const apps: Instance[] = [];

afterEach(() => {
  for (const app of apps.splice(0)) {
    app.unmount();
    app.cleanup();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Launched {
  stdout: FakeStdout;
  /** The rule width each forced redraw found in the last frame the tree had committed. */
  redrawRuleWidths: number[];
  /** Sets the new size and emits `resize`; returns the index of the first write after it. */
  resize: (columns: number, rows: number) => number;
}

async function launch(columns: number, rows: number): Promise<Launched> {
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
  const wipe = () => {
    const last = stdout.frames.filter(isFrame).at(-1) ?? '';
    redrawRuleWidths.push(ruleWidth(last));
  };
  const app = render(
    <App
      config={config}
      redrawViewport={wipe}
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
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
      // Every frame is written whole and unthrottled, so the first one after a resize is readable.
      debug: true,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  apps.push(app);
  for (let waited = 0; !stdout.frames.some(isFrame) && waited < 3000; waited += 20) await wait(20);
  await wait(100);
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
  };
}

/** The first frame written at or after `at`, read with no await since the emit. */
function firstFrameFrom(stdout: FakeStdout, at: number): string {
  const frame = stdout.frames.slice(at).find(isFrame);
  expect(frame, 'Ink drew no frame in the tick of the resize').toBeDefined();
  return frame!;
}

describe('App on a terminal resize (#538)', () => {
  it('confirms the fake stdout is the emitter Ink draws a resized frame from', async () => {
    const { stdout, resize } = await launch(152, 39);
    expect(stdout.listenerCount('resize')).toBeGreaterThanOrEqual(2);
    const at = resize(73, 39);
    expect(stdout.frames.slice(at).some(isFrame)).toBe(true);
  });

  it('lays out the first frame after each resize at the new width, then redraws it once', async () => {
    const { stdout, redrawRuleWidths, resize } = await launch(152, 39);
    const initial = stdout.frames.filter(isFrame).at(-1)!;
    // The rule's margin inside the terminal, so each size's rule width follows from it.
    const margin = 152 - ruleWidth(initial);
    expect(widestRow(initial)).toBeLessThanOrEqual(152);

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
      await wait(PAST_REDRAW_DEBOUNCE_MS);
      // One forced redraw, and the tree it repainted had already committed the new width.
      expect(redrawRuleWidths.slice(redrawsBefore), `${columns}x${rows}`).toEqual([
        columns - margin,
      ]);
    }
  });

  it('redraws once at the final size after a burst of resizes', async () => {
    const { stdout, redrawRuleWidths, resize } = await launch(152, 39);
    const margin = 152 - ruleWidth(stdout.frames.filter(isFrame).at(-1)!);
    for (const columns of [120, 100, 90, 73]) {
      const at = resize(columns, 39);
      expect(ruleWidth(firstFrameFrom(stdout, at)), `${columns} columns`).toBe(columns - margin);
      await wait(10);
    }
    await wait(PAST_REDRAW_DEBOUNCE_MS);
    expect(redrawRuleWidths).toEqual([73 - margin]);
  });

  it('does not redraw for a resize event that leaves the size unchanged', async () => {
    const { redrawRuleWidths, resize } = await launch(100, 30);
    resize(100, 30);
    await wait(PAST_REDRAW_DEBOUNCE_MS);
    expect(redrawRuleWidths).toEqual([]);
  });
});
