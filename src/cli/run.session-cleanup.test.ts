/**
 * A launch that ends before its first prompt must not leave an empty session behind (#444).
 *
 * `SESSION_ROOT` in run.ts is read from BOOK_HOME when the module loads, so each test points
 * BOOK_HOME at a fresh directory and imports the module graph again afterwards.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepeatingScriptedProvider, sseResponse } from '../test/scripted-provider.js';
import type { SessionRecord } from '../types/sessions.js';

const saved: Record<string, string | undefined> = {};
let tempDirs: string[] = [];

function stashEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

interface Launch {
  workspace: string;
  sessionsDir: string;
  runMainAction: (options: Record<string, unknown>) => Promise<void>;
  exitCodes: number[];
}

/** A fresh BOOK_HOME and workspace, and run.ts loaded against them. */
async function launch(): Promise<Launch> {
  const home = mkdtempSync(join(tmpdir(), 'book-cleanup-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'book-cleanup-ws-'));
  tempDirs.push(home, workspace);
  stashEnv('BOOK_HOME', home);
  stashEnv('BOOK_API_KEY', 'test-key');
  vi.resetModules();
  const { runMainAction } = await import('./run.js');
  const { setExitCodeFn, setExitFn } = await import('./exit.js');
  const exitCodes: number[] = [];
  setExitCodeFn((code: number) => {
    exitCodes.push(code);
  });
  setExitFn(((code: number) => {
    throw new Error(`unexpected exit(${code})`);
  }) as (code: number) => never);
  const sessionsDir = join(home, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  return { workspace, sessionsDir, runMainAction, exitCodes };
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
}

/** Ids the persisted index lists, or none when it was never written. */
function indexedIds(dir: string): string[] {
  const path = join(dir, 'session-index.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { sessions?: Record<string, unknown> };
  return Object.keys(parsed.sessions ?? {});
}

function printOptions(workspace: string, extra: Record<string, unknown> = {}) {
  return {
    print: 'fix the login bug',
    workspace,
    settings: false,
    inputFormat: 'text',
    outputFormat: 'text',
    sessionPersistence: true,
    maxTurns: '1',
    ...extra,
  };
}

afterEach(() => {
  vi.doUnmock('ink');
  vi.doUnmock('../tui/app.js');
  vi.doUnmock('../tui/interactive-assets.js');
  vi.doUnmock('./ink-scroll-renderer.js');
  vi.doUnmock('./frame-buffer.js');
  vi.doUnmock('./ink-frame-throttle.js');
  vi.doUnmock('./ink-output-cache.js');
  vi.doUnmock('./ink-render-cull.js');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('runMainAction — print mode leaves no empty session behind', () => {
  it('removes the session of a run that fails after bootstrap, before any prompt', async () => {
    const { workspace, sessionsDir, runMainAction, exitCodes } = await launch();
    const provider = createRepeatingScriptedProvider(() => sseResponse([]));
    vi.stubGlobal('fetch', provider.fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Unparseable --json-schema throws while the headless run is being set up, after the
    // session was created and before a prompt could be recorded.
    await runMainAction(printOptions(workspace, { jsonSchema: '{not json' }));

    expect(exitCodes).toEqual([1]);
    expect(provider.requests).toHaveLength(0);
    expect(sessionFiles(sessionsDir)).toEqual([]);
    expect(indexedIds(sessionsDir)).toEqual([]);
  });

  it('keeps the session of a run that recorded a prompt', async () => {
    const { workspace, sessionsDir, runMainAction } = await launch();
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMainAction(printOptions(workspace));

    const files = sessionFiles(sessionsDir);
    expect(files).toHaveLength(1);
    expect(indexedIds(sessionsDir)).toEqual([files[0]!.replace(/\.jsonl$/, '')]);
  });

  it('keeps a launch the user named with --name, even with no prompt', async () => {
    const { workspace, sessionsDir, runMainAction } = await launch();
    vi.stubGlobal('fetch', createRepeatingScriptedProvider(() => sseResponse([])).fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runMainAction(printOptions(workspace, { name: 'release-work', jsonSchema: '{not json' }));

    expect(sessionFiles(sessionsDir)).toHaveLength(1);
  });
});

describe('runMainAction — the TUI leaves no empty session behind', () => {
  /** Ink and the App are replaced: what is under test is what run.ts does once the UI is gone. */
  function mockInk(onRender?: (session: StubSession) => void): void {
    vi.doMock('ink', () => ({
      render: (element: { props: { session: StubSession } }) => {
        onRender?.(element.props.session);
        return { waitUntilExit: async () => {}, cleanup: () => {} };
      },
    }));
    vi.doMock('../tui/app.js', () => ({ App: () => null }));
    vi.doMock('../tui/interactive-assets.js', () => ({ loadInteractiveAssets: () => ({}) }));
    vi.doMock('./ink-scroll-renderer.js', () => ({ installInkScrollRenderer: async () => {} }));
    vi.doMock('./frame-buffer.js', () => ({ installFrameCapture: async () => {} }));
    vi.doMock('./ink-frame-throttle.js', () => ({ installInkFrameThrottle: async () => {} }));
    vi.doMock('./ink-output-cache.js', () => ({ installInkOutputCache: async () => {} }));
    vi.doMock('./ink-render-cull.js', () => ({ installInkRenderCull: async () => {} }));
  }

  interface StubSession {
    sessionId: string;
    timelineStore: { append(id: string, record: SessionRecord): void };
  }

  function interactiveOptions(workspace: string, extra: Record<string, unknown> = {}) {
    return { workspace, settings: false, sessionPersistence: true, ...extra };
  }

  it('removes the session when the user quits before sending anything', async () => {
    const { workspace, sessionsDir, runMainAction, exitCodes } = await launch();
    mockInk();

    await runMainAction(interactiveOptions(workspace));

    expect(exitCodes).toEqual([]);
    expect(sessionFiles(sessionsDir)).toEqual([]);
    expect(indexedIds(sessionsDir)).toEqual([]);
  });

  it('keeps the session once a prompt was recorded', async () => {
    const { workspace, sessionsDir, runMainAction } = await launch();
    mockInk((session) =>
      session.timelineStore.append(session.sessionId, {
        type: 'user',
        timestamp: Date.now(),
        data: { content: 'fix the login bug' },
      }),
    );

    await runMainAction(interactiveOptions(workspace));

    expect(sessionFiles(sessionsDir)).toHaveLength(1);
    expect(indexedIds(sessionsDir)).toHaveLength(1);
  });

  it('keeps a session a hook wrote state into, though no prompt was sent', async () => {
    const { workspace, sessionsDir, runMainAction } = await launch();
    mockInk((session) =>
      session.timelineStore.append(session.sessionId, {
        type: 'local',
        timestamp: Date.now(),
        data: { content: 'written by a SessionEnd hook' },
      }),
    );

    await runMainAction(interactiveOptions(workspace));

    expect(sessionFiles(sessionsDir)).toHaveLength(1);
  });

  it('never removes a resumed session, even one that holds no messages', async () => {
    const { workspace, sessionsDir, runMainAction } = await launch();
    mockInk();
    // The first launch leaves a named (kept) empty session; the second resumes it.
    await runMainAction(interactiveOptions(workspace, { name: 'empty-but-named' }));
    expect(sessionFiles(sessionsDir)).toHaveLength(1);

    await runMainAction(interactiveOptions(workspace, { resume: 'empty-but-named' }));

    expect(sessionFiles(sessionsDir)).toHaveLength(1);
  });
});
