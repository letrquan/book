import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { renderSessionState } from './session-state.js';
import type { Provider } from '../provider/index.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { createSessionListTool } from '../tools/session-list.js';
import { createSessionSendTool } from '../tools/session-send.js';
import { SessionMentionSnapshot } from '../input/session-mentions.js';
import type {
  PeerSendRequest,
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';
import type { AgentLoopCallbacks, ProviderMessage } from '../types/providers.js';

// `@session` notes (#620) through the whole agent loop: the note rides in the newest user turn's
// `<session-state>` block, rendered once, and the system text and tools are what they would be
// without it.

isolateBookHome('book-session-mention-notes-home-');

let workspace: string;

beforeEach(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-mention-notes-')));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const row = (name: string, extra: Partial<PeerSessionRow> = {}): PeerSessionRow => ({
  name,
  ref: '825389',
  socketPath: `/tmp/socks/${name}.sock`,
  kind: 'interactive',
  status: 'idle',
  startedAt: 0,
  sessionId: `session-${name}`,
  pid: 1,
  self: false,
  ...extra,
});

const LISTING: PeerSessionListing = {
  self: row('book-1', { self: true, ref: 'ffffff' }),
  peers: [row('book-36')],
};

function messaging(sends: PeerSendRequest[] = []): SessionMessagingHandle {
  const target = row('book-36') as PeerSessionRow & { socketPath: string };
  return {
    available: () => true,
    list: async () => LISTING,
    resolve: async (to) =>
      ['book-36', 'book-36 [825389]'].includes(to.trim())
        ? { ok: true, target }
        : { ok: false, problem: 'not_found', candidates: [] },
    send: async (request) => {
      sends.push(request);
      return { status: 'sent', target, msgId: 'm1' };
    },
  };
}

interface Captured {
  messages: ProviderMessage[][];
  tools: string[][];
}

const userText = (messages: ProviderMessage[]): string => {
  const user = messages.find((message) => message.role === 'user');
  if (typeof user?.content !== 'string') throw new Error('expected a string user turn');
  return user.content;
};

/**
 * Request 1 makes a call, so the run sends a second request; request 2 answers. The call is
 * SessionList, or with `followNote` a SessionSend to the address the note names, as a model would.
 */
function provider(captured: Captured, followNote = false): Provider {
  return {
    id: 'scripted',
    stream: async function* (_config, messages, tools) {
      captured.messages.push(structuredClone(messages));
      captured.tools.push(tools.map((tool) => tool.name));
      if (captured.messages.length === 1) {
        const to = /use SessionSend with to: "([^"]+)"/.exec(userText(messages))?.[1];
        yield followNote && to
          ? {
              type: 'tool_call',
              toolCall: {
                id: 's1',
                name: 'SessionSend',
                arguments: { to, message: 'run the tests' },
              },
            }
          : { type: 'tool_call', toolCall: { id: 'l1', name: 'SessionList', arguments: {} } };
      } else {
        yield { type: 'text', content: 'done' };
      }
      yield { type: 'done' };
    },
  } as Provider;
}

const callbacks: AgentLoopCallbacks = {
  onText: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onError: () => {},
  onTurnStart: () => {},
  onDone: () => {},
  onPermissionRequired: async () => 'allow',
  onPlanApprovalRequired: async () => 'approve',
};

async function run(
  prompt: string,
  options: { mode?: string; allow?: string[]; followNote?: boolean } = {},
) {
  const captured: Captured = { messages: [], tools: [] };
  const sends: PeerSendRequest[] = [];
  const prompted: string[] = [];
  const handle = messaging(sends);
  const snapshot = new SessionMentionSnapshot(handle);
  // The TUI's completion warms the snapshot as the mention is typed.
  await snapshot.fresh();
  const registry = createDefaultRegistry();
  registry.registerAll([createSessionListTool(handle), createSessionSendTool(handle)]);
  const config = defaultConfig({ workspace, maxTurns: 3 });
  if (options.allow) config.settings.permissions.allow = options.allow;
  await runAgentLoop(
    config,
    registry,
    prompt,
    [],
    {
      ...callbacks,
      onPermissionRequired: async (call) => {
        prompted.push(call.name);
        return 'allow';
      },
    },
    options.mode ?? 'default',
    {
      provider: provider(captured, options.followNote),
      isNewSession: false,
      typedText: prompt,
      sessionMentions: snapshot,
    },
  );
  return { ...captured, sends, prompted };
}

const systemText = (messages: ProviderMessage[]): string =>
  JSON.stringify(messages.filter((message) => message.role === 'system'));

const NOTE =
  '- The user @-mentioned the Book session "book-36 [825389]" (this machine) as @book-36. If their message asks you to tell or ask that session something, use SessionSend with to: "book-36".';

describe('@session notes in the agent loop (#620)', () => {
  it("puts the note in the user turn's <session-state> block on the first request", async () => {
    const captured = await run('ask @book-36 to run the tests');
    const first = userText(captured.messages[0]);
    const block = first.slice(first.indexOf('<session-state>'));
    expect(block).toContain(NOTE);
    expect(block.endsWith('</session-state>')).toBe(true);
    // The typed text itself is unchanged.
    expect(first.startsWith('ask @book-36 to run the tests\n\n<session-state>')).toBe(true);
  });

  it('re-renders the block byte for byte on the next request, and adds no second note', async () => {
    const captured = await run('ask @book-36 to run the tests');
    expect(captured.messages).toHaveLength(2);
    expect(userText(captured.messages[1])).toBe(userText(captured.messages[0]));
    const all = JSON.stringify(captured.messages[1]);
    expect(all.split('The user @-mentioned').length - 1).toBe(1);
  });

  it('leaves the system text and the tools unchanged', async () => {
    const mentioned = await run('ask @book-36 to run the tests');
    const plain = await run('ask the other session to run the tests');
    expect(userText(plain.messages[0])).not.toContain('@-mentioned');
    expect(systemText(mentioned.messages[0])).toBe(systemText(plain.messages[0]));
    expect(mentioned.tools[0]).toEqual(plain.tools[0]);
  });

  it("sends to the note's address under a bare-name allow rule without asking", async () => {
    const captured = await run('ask @book-36 to run the tests', {
      allow: ['SessionSend(book-36)'],
      followNote: true,
    });
    expect(captured.sends).toHaveLength(1);
    expect(captured.sends[0]).toMatchObject({ to: 'book-36' });
    expect(captured.prompted).toEqual([]);
  });

  it('adds no note in plan mode, where SessionSend is not offered', async () => {
    const captured = await run('ask @book-36 to run the tests', { mode: 'plan' });
    expect(userText(captured.messages[0])).not.toContain('@-mentioned');
  });
});

describe('renderSessionState notes (#620)', () => {
  it('renders each note as a line of the block, and nothing without notes', () => {
    const base = { workspace: '/w' };
    expect(renderSessionState({ ...base, notes: ['first note', 'second note'] })).toContain(
      '- first note\n- second note\n',
    );
    expect(renderSessionState({ ...base, notes: [] })).toBe(renderSessionState(base));
  });
});
