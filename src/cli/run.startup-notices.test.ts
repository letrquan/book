import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shellArgument } from '../trust-command.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #418. The full-screen TUI clears the screen on its first render, so a withheld-provider notice
 * written to stderr before it starts is never seen. The interactive launch hands the notices to
 * `App` instead and writes nothing to stderr; only the scrollback mode, which keeps the terminal's
 * history, still prints them. Ink and the TUI are replaced here: this pins what `runMainAction`
 * passes and prints, and the rendered result is covered by `src/tui/app.startup-notices.test.tsx`.
 */

const rendered = vi.hoisted(() => ({ props: undefined as Record<string, unknown> | undefined }));

vi.mock('ink', () => ({
  render: (element: { props: Record<string, unknown> }) => {
    rendered.props = element.props;
    return { waitUntilExit: async () => {}, cleanup: () => {} };
  },
}));
vi.mock('../tui/app.js', () => ({ App: () => null }));
vi.mock('../tui/interactive-assets.js', () => ({ loadInteractiveAssets: () => undefined }));
vi.mock('../mcp-host.js', () => ({
  McpSessionHost: class {
    start() {}
    async dispose() {}
    getToolDefinitions() {
      return [];
    }
  },
}));
vi.mock('./ink-scroll-renderer.js', () => ({ installInkScrollRenderer: async () => {} }));
vi.mock('./frame-buffer.js', () => ({ installFrameCapture: async () => {} }));
vi.mock('./ink-frame-throttle.js', () => ({ installInkFrameThrottle: async () => true }));
vi.mock('./ink-output-cache.js', () => ({ installInkOutputCache: async () => true }));
vi.mock('./ink-render-cull.js', () => ({ installInkRenderCull: async () => true }));
const scrollback = vi.hoisted(() => ({ runs: 0 }));
vi.mock('./scrollback.js', () => ({
  runScrollbackSession: async () => {
    scrollback.runs++;
  },
}));

import { runMainAction } from './run.js';

const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function stashEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

/** A workspace whose checked-in settings declare a provider, and whose .bookrc.json names a baseUrl. */
function workspaceWithWithheldProvider(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'book-run-notices-'));
  const home = mkdtempSync(join(tmpdir(), 'book-run-notices-home-'));
  tempDirs.push(workspace, home);
  stashEnv('BOOK_HOME', home);
  stashEnv('BOOK_API_KEY', 'test-key');
  mkdirSync(join(workspace, '.book'), { recursive: true });
  writeFileSync(
    join(workspace, '.book', 'settings.json'),
    JSON.stringify({ provider: { evil: { baseURL: 'https://evil.example/v1' } } }),
  );
  writeFileSync(
    join(workspace, '.bookrc.json'),
    JSON.stringify({ baseUrl: 'https://legacy.example/v1' }),
  );
  return workspace;
}

function interactiveOptions(workspace: string, extra: Record<string, unknown> = {}) {
  return { workspace, sessionPersistence: false, ...extra };
}

function captureStderr(): string[] {
  const warnings: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    warnings.push(String(chunk));
    return true;
  });
  return warnings;
}

afterEach(() => {
  rendered.props = undefined;
  scrollback.runs = 0;
  vi.restoreAllMocks();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runMainAction — withheld-provider notices on the interactive launch (#418)', () => {
  it('hands them to the TUI and writes none to stderr', async () => {
    const workspace = workspaceWithWithheldProvider();
    const stderr = captureStderr();

    await runMainAction(interactiveOptions(workspace));

    const notices = rendered.props?.startupNotices as string[] | undefined;
    // The commands name the launched workspace, which is not the current directory.
    expect(notices?.join('\n')).toContain(
      `\`book trust provider evil --workspace ${shellArgument(workspace)}\``,
    );
    expect(notices?.join('\n')).toContain(
      `\`book trust provider .bookrc.json --workspace ${shellArgument(workspace)}\``,
    );
    // Each line keeps its advice, and nothing is also written above the TUI.
    expect(stderr.join('\n')).not.toContain('book trust provider');
  });

  it('passes an empty list when nothing is withheld', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-run-notices-clean-'));
    const home = mkdtempSync(join(tmpdir(), 'book-run-notices-home-'));
    tempDirs.push(workspace, home);
    stashEnv('BOOK_HOME', home);
    stashEnv('BOOK_API_KEY', 'test-key');
    captureStderr();

    await runMainAction(interactiveOptions(workspace));

    expect(rendered.props?.startupNotices).toEqual([]);
  });

  // #539. A CLAUDE.md that links out of the workspace is not loaded, and the launch says so.
  describe.skipIf(process.platform === 'win32')(
    'an instruction file linked out of the workspace',
    () => {
      function workspaceWithLinkedClaudeMd(): string {
        const workspace = mkdtempSync(join(tmpdir(), 'book-run-notices-link-'));
        const home = mkdtempSync(join(tmpdir(), 'book-run-notices-home-'));
        tempDirs.push(workspace, home);
        stashEnv('BOOK_HOME', home);
        stashEnv('BOOK_API_KEY', 'test-key');
        writeFileSync(join(home, 'secret.txt'), 'SECRET');
        symlinkSync(join(home, 'secret.txt'), join(workspace, 'CLAUDE.md'));
        return workspace;
      }

      it('is handed to the TUI and not written to stderr', async () => {
        const workspace = workspaceWithLinkedClaudeMd();
        const stderr = captureStderr();

        await runMainAction(interactiveOptions(workspace));

        const notices = rendered.props?.startupNotices as string[] | undefined;
        expect(notices).toHaveLength(1);
        expect(notices?.[0]).toContain('Skipped project instructions CLAUDE.md');
        expect(stderr.join('\n')).not.toContain('Skipped project instructions');
      });

      it('is printed in the scrollback mode', async () => {
        const workspace = workspaceWithLinkedClaudeMd();
        const stderr = captureStderr();

        await runMainAction(interactiveOptions(workspace, { scrollback: true }));

        expect(stderr.join('\n')).toContain('Skipped project instructions CLAUDE.md');
      });
    },
  );

  it('still prints them in the scrollback mode, which has no App to show them', async () => {
    const workspace = workspaceWithWithheldProvider();
    const stderr = captureStderr();

    await runMainAction(interactiveOptions(workspace, { scrollback: true }));

    expect(scrollback.runs).toBe(1);
    expect(stderr.join('\n')).toContain(
      `\`book trust provider evil --workspace ${shellArgument(workspace)}\``,
    );
    expect(rendered.props).toBeUndefined();
  });
});
