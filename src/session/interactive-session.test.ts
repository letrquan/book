import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createSessionFixture } from '../test/session-fixture.js';
import type { Message } from '../types/messages.js';
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

      expect(result).toEqual({ status: 'completed', messages: [] });
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('SessionHistorySearch');
      expect(toolNames).toContain('SessionHistoryRead');
    } finally {
      fixture.cleanup();
    }
  });
});
