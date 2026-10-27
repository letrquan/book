import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMessages, buildSystemPromptZones, type AgentContextCache } from './context.js';
import { runAgentLoop } from './loop.js';
import {
  collectWorkspaceNotices,
  renderSessionState,
  type WorkspaceNoticeSources,
} from './session-state.js';
import type { Provider } from '../provider/index.js';
import { SessionRuntime } from '../session/runtime.js';
import { assistantMsg, defaultConfig, userMsg } from '../test/fixtures.js';
import { observeFile } from '../tools/file-provenance.js';
import { createDefaultRegistry } from '../tools/registry.js';
import type { PeerAwarenessHandle, PeerSessionsNotice } from '../types/messaging.js';
import type { ProviderMessage } from '../types/providers.js';
import type { ToolContext } from '../types/tools.js';

let workspace: string;
let runtime: SessionRuntime;

beforeEach(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-state-peers-')));
  runtime = new SessionRuntime();
});

afterEach(() => {
  runtime.dispose('test');
  rmSync(workspace, { recursive: true, force: true });
});

const PEERS: PeerSessionsNotice = {
  sameWorktree: [
    {
      name: 'book-36',
      status: 'busy',
      branch: 'feat/x',
      edits: [{ path: 'a.ts', ageMs: 120_000 }],
    },
  ],
  moreSameWorktree: 0,
  otherWorktrees: 2,
};

function handle(recorded: Array<[string, string[]]> = []): PeerAwarenessHandle {
  return {
    snapshot: async () => ({
      notice: PEERS,
      attribute: (path) =>
        path.endsWith('a.ts') ? { peer: 'book-36', ageMs: 60_000, messaging: false } : undefined,
    }),
    recordEdits: (root, paths) => recorded.push([root, [...paths]]),
  };
}

function sources(peerAwareness?: PeerAwarenessHandle): WorkspaceNoticeSources {
  return { tracker: runtime.fileChanges, ledger: runtime.fileObservationLedger, peerAwareness };
}

async function observe(name: string, text: string): Promise<string> {
  const path = join(workspace, name);
  writeFileSync(path, text);
  const ctx: ToolContext = {
    workspaceRoot: workspace,
    env: {},
    fileObservationLedger: runtime.fileObservationLedger,
    runtime,
  };
  await observeFile(ctx, path, 'read');
  return path;
}

const stateOf = (message: ProviderMessage): string => {
  if (typeof message.content !== 'string') throw new Error('expected string content');
  return message.content.slice(message.content.indexOf('<session-state>'));
};

describe('changed-on-disk and peer lines in <session-state> (#620 PR 4)', () => {
  it('renders the notice once, attributed, and re-renders every turn byte for byte', async () => {
    const config = defaultConfig({ workspace });
    const a = await observe('a.ts', 'one\n');
    writeFileSync(a, 'two\n');
    const overrides = { workspaceNotices: sources(handle()) };

    const turnOne = [userMsg('go')];
    const first = await buildMessages(config, turnOne, [], undefined, undefined, overrides);
    const state = stateOf(first[1]!);
    expect(state).toContain(
      '- a.ts changed on disk since you last read it. book-36 recorded an edit to a.ts 1m ago. Re-read it; if your changes overlap, tell the user another session is editing it.',
    );
    expect(state).toContain('  -one\n  +two');
    expect(state).toContain(
      '- Other Book sessions in this worktree: book-36 (busy, branch feat/x; recorded edits: a.ts 2m ago).',
    );
    expect(state).toContain('- Book sessions in other worktrees of this repository: 2');

    // A rebuild of the same turn reuses the bytes, whatever changed on disk since.
    const b = await observe('b.ts', 'x\n');
    writeFileSync(b, 'y\n');
    const rebuilt = await buildMessages(config, turnOne, [], undefined, undefined, overrides);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(first));

    // The next turn reports only what is new, and leaves the settled turn as it was.
    const turnTwo = [...turnOne, assistantMsg('done'), { ...userMsg('again'), id: 'u2' }];
    const second = await buildMessages(config, turnTwo, [], undefined, undefined, overrides);
    expect(JSON.stringify(second[1])).toBe(JSON.stringify(first[1]));
    expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
    const next = stateOf(second[3]!);
    expect(next).toContain('- b.ts changed on disk since you last read it.\n');
    expect(next).not.toContain('- a.ts changed on disk');
  });

  it('keeps a change unreported when the turn is cancelled before its block renders', async () => {
    const config = defaultConfig({ workspace });
    const a = await observe('a.ts', 'one\n');
    writeFileSync(a, 'two\n');
    const overrides = { workspaceNotices: sources() };
    const aborted = {
      git: async () => {
        throw new Error('The operation was aborted');
      },
    } as unknown as AgentContextCache;

    await expect(
      buildMessages(config, [userMsg('go')], [], undefined, undefined, overrides, aborted),
    ).rejects.toThrow('aborted');
    const out = await buildMessages(config, [userMsg('go')], [], undefined, undefined, overrides);

    expect(stateOf(out[1]!)).toContain('- a.ts changed on disk since you last read it.');
  });

  it('redacts with the provider keys current when the block renders, not when the run began', async () => {
    const key = 'sk-live-rotated-0123456789abcdef';
    const a = await observe('a.ts', 'A=1\n');
    writeFileSync(a, `A=1\nKEY=${key}\n`);
    let secrets: readonly string[] = [];
    const noticeSources = { ...sources(), secrets: () => secrets };
    secrets = [key];

    const { notices } = await collectWorkspaceNotices(workspace, noticeSources, []);

    expect(JSON.stringify(notices)).not.toContain(key);
  });

  it('works without a peer handle, as print mode and the SDK run', async () => {
    const config = defaultConfig({ workspace });
    const a = await observe('a.ts', 'one\n');
    writeFileSync(a, 'two\n');

    const out = await buildMessages(config, [userMsg('go')], [], undefined, undefined, {
      workspaceNotices: sources(),
    });

    expect(stateOf(out[1]!)).toContain('- a.ts changed on disk since you last read it.\n');
    expect(stateOf(out[1]!)).not.toContain('Other Book sessions');
  });

  it('leaves the cached prefix unchanged', async () => {
    const config = defaultConfig({ workspace });
    const a = await observe('a.ts', 'one\n');
    writeFileSync(a, 'two\n');

    const without = await buildSystemPromptZones(config);
    const withNotices = await buildSystemPromptZones(config, undefined, {
      workspaceNotices: sources(handle()),
    });

    expect(withNotices).toEqual(without);
  });

  it('counts the changed files beyond those it names', () => {
    expect(
      renderSessionState({
        workspace,
        changedFiles: [{ path: 'a.ts' }],
        changedFilesUnlisted: 4,
      }),
    ).toContain(
      '- a.ts changed on disk since you last read it.\n- 4 more observed files changed on disk as well; re-read any before relying on it.',
    );
  });

  it('renders nothing new for a session with no change and no peer', () => {
    expect(renderSessionState({ workspace, changedFiles: [], peers: undefined })).toBe(
      renderSessionState({ workspace }),
    );
  });
});

describe('recording edits for peers (#620 4b)', () => {
  it("records a successful mutation's path from its result, and not a failed one", async () => {
    const recorded: Array<[string, string[]]> = [];
    writeFileSync(join(workspace, 'unread.ts'), 'x\n');
    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'write-1',
              name: 'Write',
              arguments: { filePath: 'src/new.ts', content: 'export {};\n' },
            },
          };
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'edit-1',
              name: 'Edit',
              arguments: { filePath: 'unread.ts', oldString: 'x', newString: 'y' },
            },
          };
        } else {
          yield { type: 'text', content: 'done' };
        }
        yield { type: 'done' };
      },
    };

    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 3 }),
      createDefaultRegistry(),
      'write it',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow' as const,
      },
      'bypassPermissions',
      { provider, isNewSession: false, runtime, peerAwareness: handle(recorded) },
    );

    expect(
      recorded.map(([root, paths]) => [root, paths.map((p) => p.replace(/\\/g, '/'))]),
    ).toEqual([[workspace, ['src/new.ts']]]);
  });
});
