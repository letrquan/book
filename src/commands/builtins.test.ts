import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMMAND_DEFINITIONS,
  BUILTIN_COMMANDS,
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
} from './builtins.js';

function context(): BuiltinCommandContext {
  return {
    workspace: process.cwd(),
    sessionId: 'session-1',
    model: 'test-model',
    provider: 'test-provider',
    currentTurn: 2,
    messages: [],
  };
}

describe('built-in command contract', () => {
  it('has unique names and aliases with executable handlers', () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(BUILTIN_COMMAND_DEFINITIONS.every((command) => command.description.trim())).toBe(true);
    expect(
      BUILTIN_COMMAND_DEFINITIONS.every((command) => typeof command.execute === 'function'),
    ).toBe(true);
    expect(() => createBuiltinCommandRegistry()).not.toThrow();
  });

  it('resolves aliases to the canonical typed handler', () => {
    const effect = createBuiltinCommandRegistry().execute('new', 'old-session', context());
    expect(effect).toEqual({
      type: 'start-new-conversation',
      previousName: 'old-session',
    });
  });

  it('returns typed session and UI effects', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('resume', '', context())).toEqual({
      type: 'resume-conversation',
      session: undefined,
    });
    expect(registry.execute('rewind', '', context())).toEqual({
      type: 'show-modal',
      modal: 'rewind',
    });
    expect(registry.execute('help', '', context())).toEqual({
      type: 'toggle-panel',
      panel: 'help',
    });
    expect(registry.execute('providers', 'unexpected', context())).toEqual({
      type: 'local-message',
      content: 'Usage: /providers',
    });
  });

  it('executes migrated prompt commands as typed effects', () => {
    const effect = createBuiltinCommandRegistry().execute('review', 'src/commands', context());
    expect(effect).toEqual(
      expect.objectContaining({
        type: 'send-prompt',
        context: expect.objectContaining({
          allowedTools: expect.arrayContaining(['Read', 'GitDiff']),
        }),
      }),
    );
    if (effect?.type === 'send-prompt') {
      expect(effect.prompt).toContain('Focus area: src/commands');
    }
  });
});
