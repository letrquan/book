import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../test/fixtures.js';
import { SessionStore } from '../../session/store.js';

/**
 * `/config` accelerators act on the row they move the cursor to, so `f` followed
 * by Enter on the same row asks for two flips of one setting. If both read the
 * value captured at render — as the callers did when they computed
 * `!liveConfig.settings…` themselves — the pair persists one absolute value
 * twice: two presses move the setting once, and the value written to disk is
 * not the one the rows show.
 *
 * These assert the persisted values, not the call count. A count of two is
 * exactly what a stale read still produces.
 */

const persisted = vi.hoisted(() => ({ calls: [] as Array<{ key: string; value: unknown }> }));

vi.mock('../persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../persist.js')>();
  return {
    ...actual,
    persistSettingGlobal: vi.fn((key: string, value: unknown) => {
      persisted.calls.push({ key, value });
      return { ok: true };
    }),
  };
});

vi.mock('../../agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (_c: unknown, _r: unknown, _m: string, history) => history),
}));

vi.mock('../../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));

import { useAgent } from './useAgent.js';

const roots: string[] = [];
let latest: ReturnType<typeof useAgent> | undefined;

function Harness({
  config,
  session,
}: {
  config: Parameters<typeof useAgent>[0];
  session: Parameters<typeof useAgent>[1];
}) {
  latest = useAgent(config, session);
  return null;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-use-agent-toggle-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const timeline = new SessionStore(join(root, 'sessions'));
  const sessionId = timeline.create({ cwd: workspace });
  const loaded = timeline.load(sessionId);
  return {
    config: defaultConfig({ workspace }),
    session: {
      sessionId,
      history: loaded.contextHistory,
      transcript: loaded.transcript,
      contextHistory: loaded.contextHistory,
      compactBoundaries: loaded.compactBoundaries,
      rewindTargets: loaded.rewindTargets,
      activeEventIds: loaded.activeEventIds,
      source: 'startup' as const,
      persisted: false,
      created: true,
      timelineStore: timeline,
    },
  };
}

function valuesFor(key: string): unknown[] {
  return persisted.calls.filter((call) => call.key === key).map((call) => call.value);
}

afterEach(() => {
  cleanup();
  latest = undefined;
  persisted.calls.length = 0;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('settings toggles inside one React batch', () => {
  it('alternates the value written for the startup animation', () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);

    const before = latest!.liveConfig.settings.ui.startupAnimation !== false;
    // Both calls land before React flushes, which is what an accelerator plus
    // Enter on the same row produces.
    latest!.toggleStartupAnimation();
    latest!.toggleStartupAnimation();

    expect(valuesFor('ui.startupAnimation')).toEqual([!before, before]);
  });

  it('alternates the value written for thinking', () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);

    const before = latest!.liveConfig.settings.ui.showThinking === true;
    latest!.toggleShowThinking();
    latest!.toggleShowThinking();
    latest!.toggleShowThinking();

    expect(valuesFor('ui.showThinking')).toEqual([!before, before, !before]);
  });

  it('alternates the value written for memory auto-capture', () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);

    const before = latest!.liveConfig.settings.memory.autoSave === true;
    latest!.toggleMemoryAutoSave();
    latest!.toggleMemoryAutoSave();

    expect(valuesFor('memory.autoSave')).toEqual([!before, before]);
  });

  it('leaves the setting alone when the write fails', async () => {
    const { config, session } = fixture();
    render(<Harness config={config} session={session} />);

    const persist = await import('../persist.js');
    vi.mocked(persist.persistSettingGlobal).mockReturnValueOnce({ ok: false, error: 'read-only' });

    const before = latest!.liveConfig.settings.ui.startupAnimation !== false;
    // The rejecting mock replaces the recording one for that call, so the
    // refused write leaves no entry behind.
    expect(latest!.toggleStartupAnimation()).toMatchObject({ ok: false });
    expect(valuesFor('ui.startupAnimation')).toEqual([]);

    // A rejected write must not move the in-memory value either. If it had, this
    // second toggle would flip away from a state that was never saved and write
    // `before` instead.
    latest!.toggleStartupAnimation();
    expect(valuesFor('ui.startupAnimation')).toEqual([!before]);
  });
});
