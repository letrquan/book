import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUILTIN_COMMAND_DEFINITIONS,
  BUILTIN_COMMANDS,
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
} from './builtins.js';
import { defaultConfig } from '../test/fixtures.js';

function context(): BuiltinCommandContext {
  return {
    workspace: process.cwd(),
    sessionId: 'session-1',
    model: 'test-model',
    provider: 'test-provider',
    currentTurn: 2,
    messages: [],
    runtimeConfig: defaultConfig(),
    mode: 'default',
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

  it('normalizes settings command arguments before returning effects', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('theme', 'solarized', context())).toEqual({
      type: 'set-theme',
      preference: 'solarized',
    });
    expect(registry.execute('model', 'openai/gpt-5', context())).toEqual({
      type: 'set-model',
      selection: 'openai/gpt-5',
    });
    expect(registry.execute('effort', 'HIGH', context())).toEqual({
      type: 'set-effort',
      level: 'high',
    });
    expect(
      registry.execute('effort', '', {
        ...context(),
        effortUnavailableError: 'Effort is unavailable.',
      }),
    ).toEqual({ type: 'local-message', content: '✕ Effort is unavailable.' });
  });

  it('renders and persists config commands with schema-backed metadata', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-command-config-'));
    try {
      const registry = createBuiltinCommandRegistry();
      const commandContext = {
        ...context(),
        workspace,
        runtimeConfig: defaultConfig({ workspace }),
      };
      const display = registry.execute('config', '', commandContext);
      expect(display).toEqual(
        expect.objectContaining({
          type: 'local-message',
          display: expect.objectContaining({ kind: 'config' }),
        }),
      );
      expect(registry.execute('config', '--help', commandContext)).toEqual(
        expect.objectContaining({ content: expect.stringContaining('  maxTurns') }),
      );

      const result = registry.execute('config', 'maxTurns=12', commandContext);
      expect(result).toEqual(expect.objectContaining({ content: expect.stringContaining('12') }));
      expect(
        JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')),
      ).toEqual({ maxTurns: 12 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('parses memory control commands into typed effects', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('memory', 'auto-save on', context())).toEqual({
      type: 'set-memory-auto-save',
      enabled: true,
    });
    expect(registry.execute('memory', 'unknown', context())).toEqual({
      type: 'local-message',
      content: 'Usage: /memory [status|inbox|approve <n|file>|discard <n|file>|on|off|path]',
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
