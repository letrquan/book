import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createSessionFixture } from '../test/session-fixture.js';
import type { Message } from '../types/messages.js';
import type { ToolDefinition } from '../types/tools.js';
import { toolSuccess } from '../tools/result.js';
import { createInteractiveAgentSession } from './interactive-session.js';
import type { LiveSessionReporter, LiveSessionState } from '../messaging/writer.js';

/** A reporter that remembers what it was told, in order. */
function recordingReporter(): LiveSessionReporter & {
  states: LiveSessionState[];
  sessionIds: string[];
  last(): LiveSessionState | undefined;
} {
  const states: LiveSessionState[] = [];
  const sessionIds: string[] = [];
  return {
    states,
    sessionIds,
    setState: (state) => states.push(state),
    setSessionId: (sessionId) => sessionIds.push(sessionId),
    last: () => states.at(-1),
  };
}

function userMessage(id: string): Message {
  return { id, role: 'user', content: 'hello', includeInContext: true, timestamp: 1 };
}

describe('createInteractiveAgentSession', () => {
  it('composes the interactive registry outside the React host', async () => {
    const fixture = createSessionFixture('book-interactive-session-');
    try {
      const sessionId = fixture.store.create({ cwd: process.cwd() });
      let toolNames: string[] = [];
      const session = createInteractiveAgentSession({
        runLoop: async (_config, registry) => {
          toolNames = registry.getDefinitions().map((definition) => definition.name);
          return [];
        },
      });
      const userMessage: Message = {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        includeInContext: true,
        timestamp: 1,
      };

      const result = await session.send({
        config: defaultConfig(),
        displayMessage: 'hello',
        createUserMessage: () => userMessage,
        history: [],
        sessionId,
        timelineStore: fixture.store,
        registryStore: fixture.store,
        callbacks: { onEvent: () => {}, onTurnStart: () => {} },
      });

      expect(result).toEqual({
        status: 'completed',
        messages: [],
        outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
      });
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('SessionHistorySearch');
      expect(toolNames).toContain('SessionHistoryRead');
    } finally {
      fixture.cleanup();
    }
  });

  it('evaluates additional tools for every send', async () => {
    const fixture = createSessionFixture('book-interactive-session-dynamic-');
    try {
      const sessionId = fixture.store.create({ cwd: process.cwd() });
      const observedNames: string[][] = [];
      let extraTools: ToolDefinition[] = [];
      let messageCounter = 0;
      const session = createInteractiveAgentSession({
        additionalTools: () => extraTools,
        runLoop: async (_config, registry) => {
          observedNames.push(registry.getDefinitions().map((definition) => definition.name));
          return [];
        },
      });
      const send = () =>
        session.send({
          config: defaultConfig(),
          displayMessage: 'hello',
          createUserMessage: () => ({
            id: `user-${++messageCounter}`,
            role: 'user',
            content: 'hello',
            includeInContext: true,
            timestamp: messageCounter,
          }),
          history: [],
          sessionId,
          timelineStore: fixture.store,
          registryStore: fixture.store,
          callbacks: { onEvent: () => {}, onTurnStart: () => {} },
        });

      await send();
      extraTools = [
        {
          name: 'mcp__dynamic__echo',
          description: 'Late MCP tool',
          parameters: { type: 'object', properties: {} },
          execute: async () => toolSuccess('ok'),
        },
      ];
      await send();

      expect(observedNames[0]).not.toContain('mcp__dynamic__echo');
      expect(observedNames[1]).toContain('mcp__dynamic__echo');
    } finally {
      fixture.cleanup();
    }
  });

  describe('the live-session record (#620)', () => {
    it('reports busy during a turn, waiting at a prompt, and idle however the turn ends', async () => {
      const fixture = createSessionFixture('book-interactive-live-');
      try {
        const sessionId = fixture.store.create({ cwd: process.cwd() });
        const reporter = recordingReporter();
        const seen: Array<LiveSessionState | undefined> = [];
        let fail = false;
        const session = createInteractiveAgentSession({
          liveSession: reporter,
          runLoop: async (_config, _registry, _message, _history, callbacks) => {
            seen.push(reporter.last());
            const permission = callbacks.onPermissionRequired({
              id: 'call-1',
              name: 'Bash',
              arguments: { command: 'true' },
            });
            seen.push(reporter.last());
            session.interactions.settlePermission('allow', 'test');
            await permission;
            seen.push(reporter.last());
            if (fail) throw new Error('provider down');
            return [];
          },
        });
        const send = (id: string) =>
          session.send({
            config: defaultConfig(),
            displayMessage: 'hello',
            createUserMessage: () => userMessage(id),
            history: [],
            sessionId,
            timelineStore: fixture.store,
            registryStore: fixture.store,
            callbacks: { onEvent: () => {}, onTurnStart: () => {} },
          });

        await send('user-1');
        expect(seen).toEqual([
          { status: 'busy' },
          { status: 'waiting', waitingFor: 'permission prompt' },
          { status: 'busy' },
        ]);
        expect(reporter.last()).toEqual({ status: 'idle' });

        fail = true;
        const failed = await send('user-2');
        expect(failed.status).toBe('failed');
        expect(reporter.last()).toEqual({ status: 'idle' });
      } finally {
        fixture.cleanup();
      }
    });

    it('reports busy while a compaction or a send that has not reached the loop holds the session', async () => {
      const fixture = createSessionFixture('book-interactive-live-prepare-');
      try {
        const sessionId = fixture.store.create({ cwd: process.cwd() });
        const reporter = recordingReporter();
        const session = createInteractiveAgentSession({
          liveSession: reporter,
          runLoop: async () => [],
        });

        const compaction = session.operations.tryStart('compact', true);
        expect(reporter.last()).toEqual({ status: 'busy' });
        compaction?.release();
        expect(reporter.last()).toEqual({ status: 'idle' });

        let duringPrepare: LiveSessionState | undefined;
        await session.send({
          config: defaultConfig(),
          displayMessage: 'hello',
          createUserMessage: () => userMessage('user-prepare'),
          history: [],
          sessionId,
          timelineStore: fixture.store,
          registryStore: fixture.store,
          // Auto-compaction, mention expansion and the checkpoint all run here, before the loop.
          beforePrepare: async () => {
            duringPrepare = reporter.last();
          },
          callbacks: { onEvent: () => {}, onTurnStart: () => {} },
        });
        expect(duringPrepare).toEqual({ status: 'busy' });
        expect(reporter.last()).toEqual({ status: 'idle' });
      } finally {
        fixture.cleanup();
      }
    });

    it('tells the messaging runtime the status the record reports, idle from the start', async () => {
      const reporter = recordingReporter();
      const statuses: string[] = [];
      const messaging = {
        available: () => true,
        list: async () => ({ peers: [] }),
        resolve: async () => ({
          ok: false as const,
          problem: 'not_found' as const,
          candidates: [],
        }),
        send: async () => ({ status: 'unavailable' as const }),
        setSessionStatus: (status: string) => statuses.push(status),
      };
      const session = createInteractiveAgentSession({ liveSession: reporter, messaging });
      expect(statuses).toEqual(['idle']);
      const answer = session.interactions.requestUserQuestion({
        id: 'q-1',
        questions: [],
        source: { kind: 'root' },
      });
      session.interactions.cancelAll('test');
      await answer;
      // Every status the record was told, the runtime was told too, in the same order.
      expect(statuses.slice(1)).toEqual(reporter.states.map((state) => state.status));
      expect(statuses).toContain('waiting');
      expect(statuses.at(-1)).toBe('idle');
    });

    it('reports a question for the user as input needed', async () => {
      const reporter = recordingReporter();
      const session = createInteractiveAgentSession({ liveSession: reporter });
      const answer = session.interactions.requestUserQuestion({
        id: 'q-1',
        questions: [],
        source: { kind: 'root' },
      });
      expect(reporter.last()).toEqual({ status: 'waiting', waitingFor: 'input needed' });
      session.interactions.cancelAll('test');
      await answer;
      expect(reporter.last()).toEqual({ status: 'idle' });
    });

    it('follows the session id into every session the TUI starts', async () => {
      const reporter = recordingReporter();
      const started: string[] = [];
      const session = createInteractiveAgentSession({
        liveSession: reporter,
        sessionStartRunner: async (_config, sessionId) => {
          started.push(sessionId);
        },
      });
      await session.startLifecycle(defaultConfig(), 'session-a', 'startup');
      await session.startLifecycle(defaultConfig(), 'session-b', 'clear');
      expect(reporter.sessionIds).toEqual(['session-a', 'session-b']);
      expect(started).toEqual(['session-a', 'session-b']);
    });
  });
});
