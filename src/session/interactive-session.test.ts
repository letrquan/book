import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createSessionFixture } from '../test/session-fixture.js';
import type { Message } from '../types/messages.js';
import type { ToolDefinition } from '../types/tools.js';
import { toolSuccess } from '../tools/result.js';
import { createInteractiveAgentSession } from './interactive-session.js';

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
});
