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

function context(overrides: Partial<BuiltinCommandContext> = {}): BuiltinCommandContext {
  return {
    workspace: process.cwd(),
    sessionId: 'session-1',
    model: 'test-model',
    provider: 'test-provider',
    currentTurn: 2,
    messages: [],
    runtimeConfig: defaultConfig(),
    mode: 'default',
    usage: null,
    turnDurationMs: 0,
    contextHistory: [],
    compactBoundaries: [],
    commandCount: BUILTIN_COMMANDS.length,
    skillCount: 0,
    resolveAmbientContext: () => ({
      subagentCount: 0,
      hasMemoryIndex: false,
      hasClaudeMdLoader: false,
    }),
    ...overrides,
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
    expect(registry.execute('skills', '', context())).toEqual({
      type: 'show-modal',
      modal: 'skills',
    });
    expect(
      registry.execute(
        'skills',
        'status',
        context({
          skillSnapshot: {
            catalogDigest: 'catalog',
            skills: [],
            active: [],
            previous: [],
            events: [],
          },
        }),
      ),
    ).toEqual({ type: 'local-message', content: expect.stringContaining('Catalog: catalog') });
    expect(registry.execute('providers', 'unexpected', context())).toEqual({
      type: 'local-message',
      content: 'Usage: /providers',
    });
  });

  it('dispatches every former App-owned command through typed effects', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('task', 'Investigate failure', context())).toEqual({
      type: 'add-task',
      subject: 'Investigate failure',
    });
    expect(registry.execute('tasks', '', context())).toEqual({
      type: 'managed-agent',
      operation: 'list',
    });
    expect(registry.execute('agents', '', context())).toEqual({
      type: 'local-message',
      content: expect.stringContaining('/tasks'),
    });
    expect(registry.execute('agent', 'send agent-1 status update', context())).toEqual({
      type: 'managed-agent',
      operation: 'send',
      agentId: 'agent-1',
      message: 'status update',
    });
    expect(registry.execute('diff', '', context())).toEqual({ type: 'show-diff' });
    expect(registry.execute('reload-skills', '', context())).toEqual({ type: 'reload-assets' });
    expect(registry.execute('usage', '', context())).toEqual(
      expect.objectContaining({
        type: 'local-message',
        display: expect.objectContaining({ kind: 'usage' }),
      }),
    );
    expect(registry.execute('context', '', context())).toEqual(
      expect.objectContaining({
        type: 'local-message',
        display: expect.objectContaining({ kind: 'context' }),
      }),
    );
  });

  it('validates managed-agent and task arguments before returning host effects', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('task', '', context())).toEqual({
      type: 'local-message',
      content: 'Usage: /task <subject>',
    });
    expect(registry.execute('agent', '', context())).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('Usage:'),
      }),
    );
    expect(registry.execute('agent', 'stop', context())).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('Usage:'),
      }),
    );
    expect(registry.execute('agent', 'agent-1', context())).toEqual({
      type: 'managed-agent',
      operation: 'get',
      agentId: 'agent-1',
    });
    expect(registry.execute('agent', 'apply agent-1 evidence-2', context())).toEqual({
      type: 'managed-agent',
      operation: 'apply',
      agentId: 'agent-1',
      evidenceId: 'evidence-2',
    });
    expect(registry.execute('agent', 'apply agent-1', { ...context(), mode: 'plan' })).toEqual({
      type: 'local-message',
      content: '✕ Agent apply is unavailable in plan mode.',
    });
  });

  it('includes measured token cost in usage and cost reports when pricing is known', () => {
    const commandContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'gpt-4o' }),
      usage: { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
      turnDurationMs: 2500,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'hello',
          includeInContext: true,
          timestamp: 1,
        },
      ],
    };
    const registry = createBuiltinCommandRegistry();

    expect(registry.execute('cost', '', commandContext)).toEqual(
      expect.objectContaining({ type: 'local-message', content: expect.stringContaining('$') }),
    );
    expect(registry.execute('usage', '', commandContext)).toEqual(
      expect.objectContaining({
        type: 'local-message',
        display: expect.objectContaining({
          kind: 'usage',
          estimatedCostUsd: expect.any(Number),
          rate: expect.any(Object),
        }),
      }),
    );
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
      expect(display).toEqual({ type: 'show-modal', modal: 'config' });
      expect(registry.execute('config', '--help', commandContext)).toEqual(
        expect.objectContaining({ content: expect.stringContaining('  maxTurns') }),
      );

      const result = registry.execute('config', 'maxTurns=12', commandContext);
      expect(result).toEqual(expect.objectContaining({ content: expect.stringContaining('12') }));
      expect(
        JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')),
      ).toEqual({ maxTurns: 12 });

      const compactResult = registry.execute(
        'config',
        'compact-model 9router/ag/gemini-3.6-flash-high',
        commandContext,
      );
      expect(compactResult).toEqual(
        expect.objectContaining({ content: expect.stringContaining('compactModel') }),
      );
      expect(
        JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')),
      ).toMatchObject({ compactModel: '9router/ag/gemini-3.6-flash-high' });

      const strategyResult = registry.execute(
        'config',
        'compact-strategy zero-mem',
        commandContext,
      );
      expect(strategyResult).toEqual(
        expect.objectContaining({ content: expect.stringContaining('compactStrategy') }),
      );
      expect(
        JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')),
      ).toMatchObject({ compactStrategy: 'zero-mem' });
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
