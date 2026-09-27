import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // The user-layer preferences go through this rather than the bare global
    // write: it also drops the workspace-local value that would otherwise
    // outrank what was just saved and decide the next session.
    persistUserSettingClearingLocal: vi.fn((_workspace: string, key: string, value: unknown) => {
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

/**
 * The user layer resolves through BOOK_HOME, and the mock below is the only
 * thing standing between these toggles and the real `~/.book/settings.json`.
 * A mock that stops covering the function the hook actually calls is a silent
 * failure — it already happened once, and the suite wrote three keys into the
 * developer's own settings before anything went red. A home of its own means
 * the next such gap costs a wrong assertion rather than someone's config.
 */
let bookHome: string;
let previousBookHome: string | undefined;
let previousStartupAnimation: string | undefined;

beforeEach(() => {
  bookHome = mkdtempSync(join(tmpdir(), 'book-use-agent-toggle-home-'));
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = bookHome;
  previousStartupAnimation = process.env.BOOK_STARTUP_ANIMATION;
  delete process.env.BOOK_STARTUP_ANIMATION;
});

/** The user layer, of which `BOOK_HOME` is the root. */
function writeUserSettings(contents: unknown): void {
  writeFileSync(join(bookHome, 'settings.json'), JSON.stringify(contents), 'utf-8');
}

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
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  if (previousStartupAnimation === undefined) delete process.env.BOOK_STARTUP_ANIMATION;
  else process.env.BOOK_STARTUP_ANIMATION = previousStartupAnimation;
  rmSync(bookHome, { recursive: true, force: true });
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
    vi.mocked(persist.persistUserSettingClearingLocal).mockReturnValueOnce({
      ok: false,
      error: 'read-only',
    });

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

/**
 * Removing a provider re-resolves the settings and swaps the result into the
 * live config. That re-read went through the bare loader, so the splash flipped
 * back to the file's value in the middle of a session that had started under
 * `BOOK_STARTUP_ANIMATION` — and `/config` then showed a setting that did not
 * match the one the launch used.
 */
describe('the provider-removal re-read', () => {
  const providerId = 'byok';

  function writeOwnedProvider(): void {
    writeUserSettings({
      model: `${providerId}/some-model`,
      provider: { [providerId]: { type: 'openai', baseURL: 'http://x/v1', models: {} } },
      ui: { startupAnimation: true },
    });
  }

  /**
   * The live config a session starts with is what `loadConfig` produced, so the
   * fixture states the variable's value for the launch and the file's `true` is
   * only ever something the re-read can reach.
   */
  function fixtureLaunchedWith(startupAnimation: boolean) {
    const { config, session } = fixture();
    config.settings = {
      ...config.settings,
      ui: { ...config.settings.ui, startupAnimation },
    };
    return { config, session };
  }

  it('keeps the env override after a provider is removed', async () => {
    process.env.BOOK_STARTUP_ANIMATION = '0';
    writeOwnedProvider();
    const { config, session } = fixtureLaunchedWith(false);
    render(<Harness config={config} session={session} />);

    let result: { ok: boolean } | undefined;
    // `act` so the re-render lands: without it `latest` still holds the mount
    // state, and the assertion below would pass on the value it started with.
    await act(async () => {
      result = latest!.removeProvider(providerId);
    });

    expect(result).toMatchObject({ ok: true });
    // The file still says `true`; only the re-read is in question, and it has to
    // land on the variable's value the way the launch did.
    expect(latest!.liveConfig.settings.ui.startupAnimation).toBe(false);
  });

  it('falls back to the file when the variable is not set', async () => {
    writeOwnedProvider();
    const { config, session } = fixtureLaunchedWith(true);
    render(<Harness config={config} session={session} />);

    let result: { ok: boolean } | undefined;
    await act(async () => {
      result = latest!.removeProvider(providerId);
    });

    expect(result).toMatchObject({ ok: true });
    expect(latest!.liveConfig.settings.ui.startupAnimation).toBe(true);
  });
});
