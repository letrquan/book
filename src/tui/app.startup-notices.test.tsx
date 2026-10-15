import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { Message } from '../types/messages.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionStore } from '../session/store.js';

/**
 * #418. A repository's withheld provider is reported at launch, and the full-screen TUI clears the
 * screen on its first render, so a line written to stderr beforehand is never seen. The launch
 * hands the notices to `App`, which shows them once as warning rows. These run the real
 * `useAgent`: what they pin is the transcript, the session file and the model's context.
 */

// Every model request the loop would have made: the history it was handed.
const loopHistories = vi.hoisted(() => [] as Message[][]);

const managedAgentManager = vi.hoisted(() => ({
  list: async () => [],
  listPendingCompletions: async () => [],
  subscribe: () => () => {},
  setInteractivePermissions: () => {},
  send: () => {},
  stop: () => {},
  apply: () => {},
  get: () => {},
}));

vi.mock('../agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (_config: unknown, _registry: unknown, _message: string, history) => {
    loopHistories.push(structuredClone(history as Message[]));
    return history;
  }),
}));
vi.mock('../session/lifecycle.js', () => ({
  runSessionStart: vi.fn(async () => {}),
  runSessionEnd: vi.fn(async () => {}),
}));
vi.mock('../agents/manager.js', () => ({
  getOrCreateAgentManager: () => managedAgentManager,
}));

import { App } from './app.js';

const PENDING_NOTICE =
  '⚠  Ignoring workspace-declared provider "evil" (https://evil.example/v1, key: none) from ' +
  '.book/settings.json: it requires approval. Run `book trust provider evil` to review and ' +
  'approve it.';
const LEGACY_NOTICE =
  '⚠  Ignoring baseUrl "https://legacy.example/v1" from .bookrc.json: it requires approval. ' +
  'Run `book trust provider .bookrc.json` to review and approve it.';

const roots: string[] = [];
let lastFrameText = '';

function launch(options: { notices?: string[]; persisted?: Message[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'book-startup-notices-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const store = new SessionStore(join(root, 'sessions'));
  const sessionId = store.create({ cwd: workspace });
  const loaded = store.load(sessionId);
  const config = defaultConfig({ workspace });
  config.settings.ui.startupAnimation = false;
  config.accessibility = { screenReader: false, reducedMotion: true };
  const view = render(
    <App
      config={config}
      session={{
        sessionId,
        history: loaded.contextHistory,
        transcript: [...loaded.transcript, ...(options.persisted ?? [])],
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
      startupNotices={options.notices}
    />,
  );
  return { view, store, sessionId };
}

/** The frame with wrapping and indentation collapsed, so an assertion is about words not columns. */
function words(frame: string | undefined): string {
  lastFrameText = frame ?? '(no frame)';
  return (frame ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${lastFrameText}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

afterEach(() => {
  cleanup();
  loopHistories.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('App startupNotices', () => {
  it('shows each notice on the first frame, with its advice, below the title page', async () => {
    const { view } = launch({ notices: [PENDING_NOTICE, LEGACY_NOTICE] });
    await waitFor(() => words(view.lastFrame()).includes('book trust provider evil'));

    const frame = words(view.lastFrame());
    expect(frame).toContain('Ignoring workspace-declared provider "evil"');
    expect(frame).toContain('`book trust provider evil`');
    expect(frame).toContain('Ignoring baseUrl "https://legacy.example/v1"');
    expect(frame).toContain('`book trust provider .bookrc.json`');
    // The notices do not take the title page's place.
    expect(frame).toContain('O O K');
  });

  it('shows them once, however often the app renders', async () => {
    const { view } = launch({ notices: [PENDING_NOTICE] });
    await waitFor(() => words(view.lastFrame()).includes('book trust provider evil'));

    // A keystroke re-renders the composer, and with it the whole app.
    view.stdin.write('a');
    await waitFor(() => (view.lastFrame() ?? '').includes('a'));
    view.stdin.write('\x7f');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(occurrences(words(view.lastFrame()), 'book trust provider evil')).toBe(1);
  });

  it('shows nothing extra without notices', async () => {
    const { view } = launch();
    await waitFor(() => words(view.lastFrame()).includes('O O K'));

    expect(words(view.lastFrame())).not.toContain('Ignoring');
  });

  it('keeps them out of the model context and out of the session file', async () => {
    const { view, store, sessionId } = launch({ notices: [PENDING_NOTICE, LEGACY_NOTICE] });
    await waitFor(() => words(view.lastFrame()).includes('book trust provider evil'));

    view.stdin.write('hello there');
    await waitFor(() => (view.lastFrame() ?? '').includes('hello there'));
    view.stdin.write('\r');
    await waitFor(() => loopHistories.length > 0);

    // What the model is sent: none of the notice text.
    const sent = JSON.stringify(loopHistories);
    expect(sent).not.toContain('trust provider');
    expect(sent).not.toContain('Ignoring');
    // The notices stay on screen above the conversation they were never part of.
    await waitFor(() => words(view.lastFrame()).includes('hello there'));
    expect(words(view.lastFrame())).toContain('book trust provider evil');

    // Nothing was written to the session, so a later resume cannot replay them as stale.
    const saved = store.load(sessionId);
    expect(saved.transcript.map((message) => message.content).join('\n')).not.toContain(
      'trust provider',
    );
    expect(saved.contextHistory.map((message) => message.content).join('\n')).not.toContain(
      'trust provider',
    );
  });

  it("shows the current launch's notices after a resumed transcript", async () => {
    const earlier: Message[] = [
      { id: 'u1', role: 'user', content: 'earlier question', includeInContext: true, timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'earlier answer',
        includeInContext: true,
        timestamp: 2,
      },
    ];
    const { view } = launch({ notices: [LEGACY_NOTICE], persisted: earlier });
    await waitFor(() => words(view.lastFrame()).includes('book trust provider .bookrc.json'));

    const frame = words(view.lastFrame());
    expect(frame).toContain('earlier answer');
    expect(frame.indexOf('earlier answer')).toBeLessThan(frame.indexOf('Ignoring baseUrl'));
    // The title page belongs to an empty session.
    expect(frame).not.toContain('O O K');
  });
});
