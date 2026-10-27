import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from '../agent/loop.js';
import { ALWAYS_ALLOWED_TOOLS } from '../permissions.js';
import type { Provider } from '../provider/index.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Message } from '../types/messages.js';
import type {
  PeerSendOutcome,
  PeerSendRequest,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';
import type { ToolResult } from '../types/tools.js';
import { READ_ONLY_PLAN_TOOLS } from './plan-mode.js';
import { getPrimaryArg } from './primary-arg.js';
import { createDefaultRegistry } from './registry.js';
import { formatSessionListing, createSessionListTool } from './session-list.js';
import { conversationHopChain, createSessionSendTool, sessionSendResult } from './session-send.js';
import { FILE_MUTATING_TOOLS, OUTWARD_FACING_TOOLS } from './tool-capabilities.js';

isolateBookHome('book-session-tools-home-');

const row = (name: string, extra: Partial<PeerSessionRow> = {}): PeerSessionRow => ({
  name,
  ref: 'a1b2c3',
  socketPath: `/tmp/socks/${name}.sock`,
  kind: 'interactive',
  status: 'idle',
  startedAt: 0,
  sessionId: `session-${name}`,
  pid: 1,
  self: false,
  ...extra,
});

describe('SessionList', () => {
  it('names this session first, then one row per live session', () => {
    const text = formatSessionListing(
      {
        self: row('book-3f', { self: true, ref: 'ffffff' }),
        peers: [
          row('peer-b', { status: 'waiting', waitingFor: 'permission prompt', startedAt: 0 }),
          row('quiet', { ref: undefined, socketPath: undefined, status: 'busy' }),
        ],
      },
      3 * 60 * 60 * 1000,
    );
    expect(text).toBe(
      [
        'This session is `book-3f [ffffff]`: a message to it would be a message to yourself.',
        '',
        'Other live Book sessions on this machine (2):',
        '- peer-b [a1b2c3] · interactive · waiting (permission prompt) · started 3h ago',
        '- quiet · interactive · busy · started 3h ago · no inbox (messaging is off there)',
      ].join('\n'),
    );
    expect(formatSessionListing({ peers: [] }, 0)).toContain('No other Book session is running');
  });

  it('folds control characters out of a name a record holds', () => {
    const text = formatSessionListing({ peers: [row('evil\u001b[2J\nname')] }, 0);
    expect(text).not.toMatch(/[\u001b\n]name/);
    expect(text).toContain('evil [2J name [a1b2c3]');
  });
});

describe('SessionSend results', () => {
  const target = row('peer-b');
  const failure = (outcome: PeerSendOutcome) => {
    const result = sessionSendResult(outcome);
    return {
      code: result.structuredError?.code,
      text: `${result.structuredError?.message}\n${result.structuredError?.remediation ?? ''}`,
    };
  };

  it('says a sent message reached the inbox, not that it was read', () => {
    const result = sessionSendResult({ status: 'sent', target, msgId: 'm1' });
    expect(result.status).toBe('success');
    expect(result.content).toBe(
      "Sent to peer-b [a1b2c3]. It reached that session's inbox; that is not proof its model read it.",
    );
  });

  it('maps every transport result to its remedy', () => {
    expect(failure({ status: 'message_too_large', detail: 'over 1 MiB', target })).toMatchObject({
      code: 'message_too_large',
      text: expect.stringContaining('Put bulk content in a file and send its path'),
    });
    expect(failure({ status: 'gone', detail: 'ENOENT', target })).toMatchObject({
      code: 'session_gone',
      text: expect.stringContaining('Call SessionList again'),
    });
    expect(failure({ status: 'busy', detail: 'timeout', target })).toMatchObject({
      code: 'session_busy',
      text: expect.stringContaining('Try again shortly'),
    });
    expect(failure({ status: 'sender_paced', detail: 'paced', target })).toMatchObject({
      code: 'sender_paced',
      text: expect.stringContaining('batch what remains into one message'),
    });
    expect(failure({ status: 'failed', detail: 'EACCES', target }).code).toBe(
      'session_send_failed',
    );
    expect(
      sessionSendResult({ status: 'busy', detail: 'x', target }).structuredError?.retryable,
    ).toBe(true);
  });

  it('explains every address problem', () => {
    const unresolved = (
      problem: 'not_found' | 'ambiguous' | 'self' | 'no_inbox',
      candidates: PeerSessionRow[] = [],
    ) => failure({ status: 'unresolved', problem, to: 'twin', candidates });
    expect(unresolved('not_found')).toMatchObject({
      code: 'session_not_found',
      text: expect.stringContaining('Call SessionList'),
    });
    expect(unresolved('self').text).toContain('a message to yourself');
    expect(unresolved('no_inbox', [row('twin', { ref: undefined })]).text).toContain(
      'twin has no inbox',
    );
    expect(
      unresolved('ambiguous', [row('twin', { ref: '111111' }), row('twin', { ref: '222222' })]),
    ).toMatchObject({
      code: 'session_ambiguous',
      text: expect.stringMatching(/twin \[111111\], twin \[222222\][\s\S]*`name \[ref\]`/),
    });
    expect(failure({ status: 'unavailable' }).code).toBe('messaging_unavailable');
  });

  it('continues the relay chain of the newest peer message in the conversation', () => {
    const peerTurn = (id: string, hopChain?: string[]): Message => ({
      id,
      role: 'user',
      content: '',
      includeInContext: true,
      kind: 'peer-message',
      peerMessages: [
        { attributed: true, body: 'x', receivedAt: 0, ...(hopChain ? { hopChain } : {}) },
      ],
      timestamp: 0,
    });
    expect(conversationHopChain([])).toBeUndefined();
    expect(
      conversationHopChain([peerTurn('1', ['a']), peerTurn('2', ['b']), peerTurn('3')]),
    ).toEqual(['b']);
  });

  it("makes the recipient, not the message, the call's rule identity", () => {
    expect(getPrimaryArg({ to: 'book-3f', message: 'hello' })).toBe('book-3f');
    expect(getPrimaryArg({ message: 'hello' })).toBe('hello');
  });
});

/** A handle that records every send. */
function fakeMessaging(): SessionMessagingHandle & { sends: PeerSendRequest[] } {
  const sends: PeerSendRequest[] = [];
  return {
    sends,
    available: () => true,
    list: async () => ({ self: row('me', { self: true }), peers: [row('peer-b')] }),
    send: async (request) => {
      sends.push(request);
      return { status: 'sent', target: row('peer-b'), msgId: `m${sends.length}` };
    },
  };
}

/** Turn 1 calls SessionList and SessionSend; every later turn answers with text. */
function provider(): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      turn++;
      if (turn === 1) {
        yield {
          type: 'tool_call' as const,
          toolCall: { id: 'l1', name: 'SessionList', arguments: {} },
        };
        yield {
          type: 'tool_call' as const,
          toolCall: {
            id: 's1',
            name: 'SessionSend',
            arguments: { to: 'peer-b', message: 'hello' },
          },
        };
      } else {
        yield { type: 'text' as const, content: 'done' };
      }
      yield { type: 'done' as const };
    },
  };
}

function callbacks(overrides: Partial<AgentLoopCallbacks>): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow' as const,
    ...overrides,
  };
}

describe('SessionList and SessionSend permissions (D7)', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-session-tools-'));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  async function run(
    mode: string,
    options: { allowedTools?: string[]; isSubagent?: boolean; deny?: string[] } = {},
  ) {
    const messaging = fakeMessaging();
    const registry = createDefaultRegistry();
    registry.registerAll([createSessionListTool(messaging), createSessionSendTool(messaging)]);
    const config = defaultConfig({ workspace, maxTurns: 2 });
    if (options.deny) config.settings.permissions.deny = options.deny;
    const prompted = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      config,
      registry,
      'message peer-b',
      [],
      callbacks({ onPermissionRequired: prompted, onToolResult: (result) => results.push(result) }),
      mode,
      {
        provider: provider(),
        isNewSession: false,
        ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
        ...(options.isSubagent ? { isSubagent: true } : {}),
      },
    );
    const byId = (id: string) => results.find((result) => result.toolCallId === id);
    return {
      list: byId('l1'),
      send: byId('s1'),
      sends: messaging.sends,
      promptedFor: prompted.mock.calls.map(
        (call) => (call as unknown as [{ name: string }])[0].name,
      ),
    };
  }

  it('asks for SessionSend in default and accept-edits, and sends once approved', async () => {
    for (const mode of ['default', 'accept-edits']) {
      const outcome = await run(mode);
      expect(outcome.promptedFor, mode).toEqual(['SessionSend']);
      expect(outcome.list?.status, mode).toBe('success');
      expect(outcome.send?.status, mode).toBe('success');
      expect(outcome.sends, mode).toHaveLength(1);
    }
  });

  it('marks the send with the mode it ran in', async () => {
    expect((await run('default')).sends[0]).toMatchObject({ to: 'peer-b', mode: 'default' });
    expect((await run('auto')).sends[0]).toMatchObject({ mode: 'auto' });
  });

  it('sends without asking only in auto and bypassPermissions', async () => {
    for (const mode of ['auto', 'bypassPermissions']) {
      const outcome = await run(mode);
      expect(outcome.promptedFor, mode).toEqual([]);
      expect(outcome.send?.status, mode).toBe('success');
      expect(outcome.sends, mode).toHaveLength(1);
    }
  });

  it('refuses SessionSend in dontAsk and hides it in plan, while SessionList runs in both', async () => {
    for (const mode of ['dontAsk', 'plan']) {
      const outcome = await run(mode);
      expect(outcome.promptedFor, mode).toEqual([]);
      expect(outcome.list?.status, mode).toBe('success');
      expect(outcome.send?.status, mode).not.toBe('success');
      expect(outcome.sends, mode).toEqual([]);
    }
  });

  it('holds a deny rule even under bypassPermissions', async () => {
    const outcome = await run('bypassPermissions', { deny: ['SessionSend(peer-b)'] });
    expect(outcome.send?.structuredError?.code).toBe('permission_denied');
    expect(outcome.sends).toEqual([]);
  });

  it('is not offered to a skill or command whose allowed tools leave it out, nor to a child agent', async () => {
    const skill = await run('bypassPermissions', { allowedTools: ['Read', 'SessionList'] });
    expect(skill.list?.status).toBe('success');
    expect(skill.send?.status).not.toBe('success');
    expect(skill.sends).toEqual([]);
    const child = await run('bypassPermissions', { isSubagent: true });
    expect(child.list?.status).not.toBe('success');
    expect(child.send?.status).not.toBe('success');
    expect(child.sends).toEqual([]);
  });

  it('keeps every outward-facing tool out of every allow-set', () => {
    for (const name of OUTWARD_FACING_TOOLS) {
      expect(ALWAYS_ALLOWED_TOOLS.has(name)).toBe(false);
      expect(READ_ONLY_PLAN_TOOLS.has(name)).toBe(false);
      expect(FILE_MUTATING_TOOLS.has(name)).toBe(false);
    }
    expect(ALWAYS_ALLOWED_TOOLS.has('SessionList')).toBe(true);
    expect(READ_ONLY_PLAN_TOOLS.has('SessionList')).toBe(true);
  });

  it('exists only where a messaging runtime is given: never in the default registry', () => {
    const names = createDefaultRegistry()
      .getDefinitions()
      .map((definition) => definition.name);
    expect(names).not.toContain('SessionList');
    expect(names).not.toContain('SessionSend');
  });
});
