import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUILTIN_COMMAND_DEFINITIONS,
  BUILTIN_COMMANDS,
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
} from './builtins.js';
import { defaultConfig } from '../test/fixtures.js';
import { DEFAULT_CONTEXT_WINDOW } from '../models.js';

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

  it('opens the login overlay, preselecting a named profile', () => {
    const registry = createBuiltinCommandRegistry();
    expect(registry.execute('login', '', context())).toEqual({
      type: 'show-modal',
      modal: 'login',
      profile: undefined,
    });
    expect(registry.execute('login', 'codex', context())).toEqual({
      type: 'show-modal',
      modal: 'login',
      profile: 'codex',
    });
  });

  it('refuses an unknown /login profile instead of opening on a different vendor', () => {
    const effect = createBuiltinCommandRegistry().execute('login', 'anthrpic', context());
    expect(effect).toEqual({
      type: 'local-message',
      content: expect.stringContaining('Unknown auth profile "anthrpic"'),
    });
    expect((effect as { content: string }).content).toContain('anthropic, codex');
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
        'mcp',
        '',
        context({
          mcpSnapshot: {
            servers: [
              {
                name: 'github',
                source: 'user',
                path: '/home/me/.book/mcp.json',
                target: 'http https://example.test/mcp',
                envKeys: [],
                headerKeys: ['Authorization'],
                fingerprint: 'fingerprint',
                status: 'connected',
                toolCount: 2,
                configChangedSinceApproval: false,
              },
            ],
            pendingApprovals: [],
            events: [],
          },
        }),
      ),
    ).toEqual({ type: 'local-message', content: expect.stringContaining('github') });
    expect(registry.execute('mcp', 'unknown', context())).toEqual({
      type: 'local-message',
      content: 'Usage: /mcp [status]',
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

  it('reports the context window compaction acts on, not max output tokens', () => {
    const registry = createBuiltinCommandRegistry();

    // No modelInfo: the window must be the compaction default, not runtimeConfig.maxTokens.
    // maxTokens (128k here) is a max *output* budget; reporting it as the window understated
    // the real 272k default and disagreed with the TUI status bar, which already used
    // resolveContextLimit.
    const unknownModel = registry.execute('context', '', context());
    expect(unknownModel).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({ kind: 'context', maxTokens: DEFAULT_CONTEXT_WINDOW }),
      }),
    );

    // ...and it is labelled as an assumption, so an 8k local model behind a router is
    // not silently reported as having 272k of headroom.
    expect(unknownModel).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({ windowSource: 'default', windowDeclared: false }),
      }),
    );

    // A model that declares a window still wins.
    const known = registry.execute(
      'context',
      '',
      context({ runtimeConfig: defaultConfig({ modelInfo: { contextWindow: 1_048_576 } }) }),
    );
    expect(known).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'context',
          maxTokens: 1_048_576,
          windowSource: 'declared',
          windowDeclared: true,
        }),
      }),
    );

    // A model matching a known family resolves its window from the family table.
    const familyModel = registry.execute(
      'context',
      '',
      context({
        runtimeConfig: defaultConfig({ model: '9router/ag/gemini-3.8-flash-high' }),
      }),
    );
    expect(familyModel).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'context',
          maxTokens: 1_048_576,
          windowSource: 'family',
          windowDeclared: false,
        }),
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
    // `/config <key>=<value>` writes the user-global layer, which resolves
    // through BOOK_HOME. Without one of its own this test would edit the
    // developer's real ~/.book/settings.json.
    const bookHome = mkdtempSync(join(tmpdir(), 'book-command-config-home-'));
    const previousBookHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = bookHome;
    const globalSettings = () => JSON.parse(readFileSync(join(bookHome, 'settings.json'), 'utf-8'));
    const localSettings = () =>
      JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8'));
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

      // A key with no live setter lands in the user-global layer, like
      // `book config set` — and says so, naming the file and the fact that a
      // file write on its own waits for the next start.
      const result = registry.execute('config', 'maxTurns=12', commandContext);
      expect(result).toEqual(
        expect.objectContaining({ content: expect.stringContaining('user-global') }),
      );
      expect(result).toEqual(
        expect.objectContaining({ content: expect.stringContaining('next start') }),
      );
      expect(globalSettings()).toEqual({ maxTurns: 12 });
      expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);

      // An explicit scope is honoured literally, so the workspace layer stays
      // reachable for what is genuinely about this checkout.
      registry.execute('config', '--local maxTurns=3', commandContext);
      expect(localSettings()).toEqual({ maxTurns: 3 });

      // The settings a running session holds outside `settings` are handed to
      // the same effect the menu and the dedicated command use, so
      // `/config model=x` is `/model x` rather than a file write nothing reads.
      expect(registry.execute('config', 'model=openai/gpt-5', commandContext)).toEqual({
        type: 'set-model',
        selection: 'openai/gpt-5',
      });
      expect(registry.execute('config', 'theme=light', commandContext)).toEqual({
        type: 'set-theme',
        preference: 'light',
      });
      expect(registry.execute('config', 'effort=xhigh', commandContext)).toEqual({
        type: 'set-effort',
        level: 'xhigh',
      });
      expect(registry.execute('config', 'defaultMode=acceptEdits', commandContext)).toEqual({
        type: 'set-default-permission-mode',
        mode: 'accept-edits',
      });
      // The three booleans the menu toggles in place had been left out of that
      // list, so the typed form still reported "next start" for a setting the
      // row directly above it changed immediately.
      expect(registry.execute('config', 'ui.showThinking=false', commandContext)).toEqual({
        type: 'set-show-thinking',
        enabled: false,
      });
      expect(registry.execute('config', 'ui.startupAnimation=true', commandContext)).toEqual({
        type: 'set-startup-animation',
        enabled: true,
      });
      expect(registry.execute('config', 'memory.autoSave=true', commandContext)).toEqual({
        type: 'set-memory-auto-save',
        enabled: true,
      });
      expect(registry.execute('config', 'ui.showThinking=yes', commandContext)).toEqual(
        expect.objectContaining({ content: expect.stringContaining('takes true or false') }),
      );

      // Naming the layer a setting already uses is the same request as naming
      // none. The explicit form used to do strictly less to the same file:
      // no live apply, no stale-local cleanup, and a "next start" that was
      // wrong because the session had not been told.
      expect(registry.execute('config', '--global model=openai/gpt-5', commandContext)).toEqual({
        type: 'set-model',
        selection: 'openai/gpt-5',
      });
      expect(registry.execute('config', '-g effort=high', commandContext)).toEqual({
        type: 'set-effort',
        level: 'high',
      });
      // …and naming a different one is a request to write that file, which the
      // reply says plainly, warning that the setting's own layer still wins.
      const globalTheme = registry.execute('config', '--global theme=light', commandContext);
      expect(globalTheme).toEqual(
        expect.objectContaining({ content: expect.stringContaining('next start') }),
      );
      expect(globalTheme).toEqual(
        expect.objectContaining({ content: expect.stringContaining('user-global') }),
      );

      const compactResult = registry.execute(
        'config',
        'compact-model 9router/ag/gemini-3.6-flash-high',
        commandContext,
      );
      expect(compactResult).toEqual({
        type: 'set-compact-model',
        model: '9router/ag/gemini-3.6-flash-high',
      });
      // A scope flag reads the same before or after the keyword; swallowing the
      // trailing one set the compact model to the literal string "--local …".
      registry.execute('config', 'compact-model --local 9router/ag/x', commandContext);
      expect(localSettings()).toMatchObject({ compactModel: '9router/ag/x' });
      expect(
        registry.execute('config', '--local compact-model --global x', commandContext),
      ).toEqual(expect.objectContaining({ content: expect.stringContaining('at most one of') }));

      const strategyResult = registry.execute(
        'config',
        'compact-strategy zero-mem',
        commandContext,
      );
      expect(strategyResult).toEqual(
        expect.objectContaining({ content: expect.stringContaining('BOOK_EXPERIMENTAL_ZERO_MEM') }),
      );
      const experimentalResult = registry.execute(
        'config',
        'experimental.zeroMem=true',
        commandContext,
      );
      expect(experimentalResult).toEqual(
        expect.objectContaining({ content: expect.stringContaining('cannot be written') }),
      );

      // The guards `book config set` had and the TUI did not: a key nothing
      // reads used to report success and change nothing, in either direction.
      expect(registry.execute('config', 'notAKey=1', commandContext)).toEqual(
        expect.objectContaining({ content: expect.stringContaining('Unknown top-level key') }),
      );
      expect(
        registry.execute('config', 'permissions.projectAllowRules=[]', commandContext),
      ).toEqual(expect.objectContaining({ content: expect.stringContaining('book trust rule') }));
      // `--user` is not a flag `book config` defines, so it is a key here and
      // fails as one rather than quietly meaning something the CLI rejects.
      expect(registry.execute('config', '--user maxTurns=4', commandContext)).toEqual(
        expect.objectContaining({ content: expect.stringContaining('Unknown top-level key') }),
      );
      expect(registry.execute('config', '--global --local maxTurns=4', commandContext)).toEqual(
        expect.objectContaining({
          content: expect.stringContaining(
            'Pass at most one of --global, --project, --local. ' +
              'Writes default to --global; reads without one report the resolved merge.',
          ),
        }),
      );

      // Only the two writes that named a file landed in it; every refusal and
      // every live-setting delegation left the layer alone.
      expect(globalSettings()).toEqual({ maxTurns: 12, theme: 'light' });
    } finally {
      if (previousBookHome === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previousBookHome;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(bookHome, { recursive: true, force: true });
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

  it('routes ordinary review invocations through the immutable review effect', () => {
    const effect = createBuiltinCommandRegistry().execute('review', 'src/commands', context());
    expect(effect).toEqual({
      type: 'review',
      scope: { base: undefined, target: 'src/commands', deep: false, fix: false, help: false },
    });
  });

  it('routes deep/fix review invocations to the review effect', () => {
    const deep = createBuiltinCommandRegistry().execute('review', '--deep', context());
    expect(deep).toEqual({
      type: 'review',
      scope: { base: undefined, target: undefined, deep: true, fix: false, help: false },
    });

    const fix = createBuiltinCommandRegistry().execute('review', '--fix --base main', context());
    expect(fix).toEqual({
      type: 'review',
      scope: { base: 'main', target: undefined, deep: true, fix: true, help: false },
    });
  });
});
