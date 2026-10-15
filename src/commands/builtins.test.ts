import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUILTIN_COMMAND_DEFINITIONS,
  BUILTIN_COMMANDS,
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
} from './builtins.js';
import { defaultConfig } from '../test/fixtures.js';
import { loadConfig, resolveAdvisorModelConfig } from '../config.js';
import {
  persistWorkspaceProviderChoice,
  workspaceProviderFingerprint,
} from '../provider-approvals.js';
import { getProjectMemoryDir } from '../memory-store.js';
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
      type: 'show-modal',
      modal: 'agents',
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
      type: 'toggle-panel',
      panel: 'tasks',
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

  it('prices /usage for a dated model id and counts its cached tokens', () => {
    const registry = createBuiltinCommandRegistry();
    const effect = registry.execute('usage', '', {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-sonnet-5-20260115' }),
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 9000,
      },
    });
    expect(effect).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'usage',
          rate: { inputPerMillion: 2, outputPerMillion: 10 },
          estimatedCostUsd: expect.closeTo(0.0088, 6),
        }),
      }),
    );
  });

  it('prices /cost and /usage from the session total, not the last request (#370)', () => {
    // `usage` is the per-request figure the context meter keeps: the TUI replaces
    // it on every model response and nulls it on every send. Reporting a session
    // bill from it showed only the final turn's tokens.
    const registry = createBuiltinCommandRegistry();
    const commandContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'gpt-4o' }),
      usage: { promptTokens: 2_000, completionTokens: 200, totalTokens: 2_200 },
      sessionUsage: { promptTokens: 3_000, completionTokens: 300, totalTokens: 3_300 },
    };
    const cost = registry.execute('cost', '', commandContext);
    expect(cost).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('3,300 tokens (3,000 in, 300 out)'),
      }),
    );
    expect(cost).not.toEqual(
      expect.objectContaining({
        content: expect.stringContaining('2,200 tokens (2,000 in, 200 out)'),
      }),
    );
    const usage = registry.execute('usage', '', commandContext);
    expect(usage).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('total 3,300'),
        display: expect.objectContaining({
          kind: 'usage',
          usage: { promptTokens: 3_000, completionTokens: 300, totalTokens: 3_300 },
        }),
      }),
    );
  });

  it('counts a delegated agent in /usage as well as /cost (#370)', () => {
    // /usage priced the lead's usage and dropped `delegatedUsage`, so a session
    // that delegated reported less than it had actually spent.
    const registry = createBuiltinCommandRegistry();
    const commandContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-sonnet-5' }),
      usage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      delegatedUsage: [
        {
          label: 'explorer "map auth"',
          model: 'claude-haiku-4-5-20251001',
          usage: { promptTokens: 500, completionTokens: 50, totalTokens: 550 },
        },
      ],
    };
    for (const command of ['cost', 'usage']) {
      const effect = registry.execute(command, '', commandContext);
      expect(effect, command).toEqual(
        expect.objectContaining({
          type: 'local-message',
          content: expect.stringContaining('claude-haiku-4-5-20251001 (1 delegated)'),
        }),
      );
    }
  });

  it('prices tiered Haiku 5.5 in /cost and /usage per request when sessionCostUsd is present (#415)', () => {
    const registry = createBuiltinCommandRegistry();
    // Two 60k requests: 60k * 0.1 / 1e6 = 0.006 each -> 0.012 sessionCostUsd
    const commandContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-haiku-5-5' }),
      sessionUsage: { promptTokens: 120_000, completionTokens: 0, totalTokens: 120_000 },
      sessionCostUsd: 0.012,
    };
    const cost = registry.execute('cost', '', commandContext);
    expect(cost).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('$0.0120 estimated'),
      }),
    );
    expect((cost as { content: string }).content).not.toContain('upper bound:');

    // Without sessionCostUsd (pooled), uses the higher tier and shows the upper bound note
    const pooledContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-haiku-5-5' }),
      sessionUsage: { promptTokens: 120_000, completionTokens: 0, totalTokens: 120_000 },
    };
    const pooledCost = registry.execute('cost', '', pooledContext);
    expect(pooledCost).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('$0.0600 estimated'),
      }),
    );
    expect((pooledCost as { content: string }).content).toContain('upper bound:');

    const usage = registry.execute('usage', '', commandContext);
    expect(usage).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'usage',
          rate: expect.objectContaining({
            inputPerMillion: 0.1,
            outputPerMillion: 0.5,
            longPrompt: {
              overPromptTokens: 100_000,
              inputPerMillion: 0.5,
              outputPerMillion: 2.5,
            },
          }),
        }),
      }),
    );
  });

  it('falls back to pricing usage when sessionUsage is null and sessionCostUsd is 0 (#415)', () => {
    const registry = createBuiltinCommandRegistry();
    const commandContext: BuiltinCommandContext = {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-sonnet-5-5' }),
      sessionUsage: null,
      usage: { promptTokens: 10_000, completionTokens: 1_000, totalTokens: 11_000 },
      sessionCostUsd: 0,
    };
    const cost = registry.execute('cost', '', commandContext);
    expect(cost).toEqual(
      expect.objectContaining({
        type: 'local-message',
        content: expect.stringContaining('$0.0300 estimated'),
      }),
    );
    expect((cost as { content: string }).content).not.toContain('$0.0000');
  });

  it('carries the delegated totals into the /usage sheet the TUI renders (#370)', () => {
    // The sheet is built from `display`, not from `content`: the text included
    // the agents while the panel they both accompany did not, so the number on
    // screen was smaller than the report beside it.
    const registry = createBuiltinCommandRegistry();
    const effect = registry.execute('usage', '', {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-sonnet-5' }),
      sessionUsage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      delegatedUsage: [
        {
          label: 'explorer "map auth"',
          model: 'claude-sonnet-5',
          usage: { promptTokens: 500_000, completionTokens: 0, totalTokens: 500_000 },
        },
      ],
    });
    expect(effect).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({
          kind: 'usage',
          usage: {
            promptTokens: 501_000,
            completionTokens: 100,
            totalTokens: 501_100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          estimatedCostUsd: expect.closeTo(1.003, 6),
          delegatedAgents: 1,
        }),
      }),
    );
  });

  it('leaves the delegated count off a session that spawned nothing', () => {
    const effect = createBuiltinCommandRegistry().execute('usage', '', {
      ...context(),
      runtimeConfig: defaultConfig({ model: 'claude-sonnet-5' }),
      sessionUsage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
    });
    expect(effect).toEqual(
      expect.objectContaining({
        display: expect.objectContaining({ kind: 'usage' }),
      }),
    );
    expect(effect).not.toEqual(
      expect.objectContaining({ display: expect.objectContaining({ delegatedAgents: 1 }) }),
    );
  });

  it('says a bill that started at a resume counts from there (#370)', () => {
    const registry = createBuiltinCommandRegistry();
    for (const command of ['cost', 'usage']) {
      const effect = registry.execute(command, '', {
        ...context(),
        runtimeConfig: defaultConfig({ model: 'claude-sonnet-5' }),
        sessionUsage: { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
        sessionUsageSinceResume: true,
      });
      expect(effect, command).toEqual(
        expect.objectContaining({
          content: expect.stringContaining('since this session was resumed'),
        }),
      );
    }
  });

  it('normalizes settings command arguments before returning effects', () => {
    const registry = createBuiltinCommandRegistry();
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
      const localModel = registry.execute('config', '--local model=openai/gpt-5', commandContext);
      expect(localModel).toEqual(
        expect.objectContaining({ content: expect.stringContaining('next start') }),
      );
      expect(localModel).toEqual(
        expect.objectContaining({ content: expect.stringContaining('local') }),
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

      const shellResult = registry.execute('config', 'shell=pwsh', commandContext);
      expect(shellResult).toEqual(
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
      expect(globalSettings()).toEqual({ maxTurns: 12 });
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
    const usage = {
      type: 'local-message',
      content: 'Usage: /memory [status|delete <file>|on|off|path]',
    };
    expect(registry.execute('memory', 'unknown', context())).toEqual(usage);
    // The inbox is gone, and its commands with it.
    for (const retired of ['inbox', 'approve 1', 'discard 1']) {
      expect(registry.execute('memory', retired, context()), retired).toEqual(usage);
    }
  });

  it('reports and deletes memories from the store on disk', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-command-memory-'));
    const bookHome = mkdtempSync(join(tmpdir(), 'book-command-memory-home-'));
    const previousBookHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = bookHome;
    try {
      // Files as the model writes them: new frontmatter, and the old layout side by side.
      const memoryDir = getProjectMemoryDir(workspace);
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(join(memoryDir, '.format'), '2\n'); // already migrated: the old file stays as is
      const first = join(memoryDir, 'build-cmd.md');
      const second = join(memoryDir, 'terse.md');
      writeFileSync(
        first,
        '---\nname: build-cmd\ndescription: Build command\nmetadata:\n  type: project\n---\nUse npm run build.\n',
      );
      writeFileSync(
        second,
        '---\ntype: user\nstatus: approved\n---\n# Prefers terse output\nShort.\n',
      );
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        '- [Build command](build-cmd.md) — how to build\n- [Terse](terse.md) — short answers\nA hand-written note.\n',
      );

      const registry = createBuiltinCommandRegistry();

      // The runtime config carries the session-start snapshot, which knows
      // nothing about either write: `/memory status` must read the disk.
      const status = registry.execute('memory', 'status', context({ workspace }));
      expect(status).toEqual(
        expect.objectContaining({
          type: 'local-message',
          content: expect.stringContaining('- Build command (project) — build-cmd.md'),
        }),
      );
      expect(status).toEqual(
        expect.objectContaining({
          content: expect.stringContaining('- Terse (user) — terse.md'),
        }),
      );

      expect(registry.execute('memory', 'delete terse.md', context({ workspace }))).toEqual({
        type: 'local-message',
        content: `Deleted memory → \`${second}\``,
        refreshMemory: true,
      });
      expect(existsSync(second)).toBe(false);
      // The file's index line goes with it; every other line stays as it was.
      expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(
        '- [Build command](build-cmd.md) — how to build\nA hand-written note.\n',
      );

      // A file name only. `1` is not an index into the listing `/memory status`
      // printed: a model write between the two commands can shift it, and the
      // wrong entry would be deleted with nothing to show for it.
      expect(registry.execute('memory', 'delete 1', context({ workspace }))).toEqual({
        type: 'local-message',
        content: '✕ Memory file not found: 1.md',
        refreshMemory: false,
      });
      expect(existsSync(first)).toBe(true);

      expect(registry.execute('memory', 'delete', context({ workspace }))).toEqual({
        type: 'local-message',
        content: '✕ Usage: /memory delete <file>',
        refreshMemory: false,
      });
      expect(existsSync(first)).toBe(true);
    } finally {
      if (previousBookHome === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previousBookHome;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(bookHome, { recursive: true, force: true });
    }
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

describe('/goal', () => {
  const registry = createBuiltinCommandRegistry();

  it('reports the goal with no argument', () => {
    expect(registry.execute('goal', '', context())).toEqual({
      type: 'local-message',
      content: 'No goal set. Usage: `/goal <condition>`',
    });
    const activeGoal = {
      condition: 'tests pass',
      iterations: 1,
      setAt: 0,
      origin: 'user' as const,
      outputTokens: 0,
      lastReason: 'one failing',
    };
    expect(registry.execute('goal', '', context({ activeGoal }))).toMatchObject({
      content: 'Goal active: tests pass (1 turn)\nLast check: one failing',
    });
  });

  it('sets the condition exactly as typed', () => {
    expect(registry.execute('goal', 'npm test exits 0', context())).toEqual({
      type: 'set-goal',
      condition: 'npm test exits 0',
    });
  });

  it('clears on any clear word', () => {
    for (const word of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
      expect(registry.execute('goal', word, context())).toEqual({ type: 'clear-goal' });
    }
  });

  it('rejects a condition over the limit', () => {
    expect(registry.execute('goal', 'x'.repeat(4_001), context())).toMatchObject({
      type: 'local-message',
      isError: true,
      content: 'Goal condition is limited to 4000 characters (got 4001)',
    });
  });
});

describe('/advisor', () => {
  const registry = createBuiltinCommandRegistry();

  it('opens the advisor model picker when given no argument', () => {
    expect(registry.execute('advisor', '', context())).toEqual({
      type: 'show-modal',
      modal: 'advisor',
    });
    expect(registry.execute('advisor', '   ', context())).toEqual({
      type: 'show-modal',
      modal: 'advisor',
    });
  });

  it('opens the picker whether or not an advisor is already set', () => {
    const runtimeConfig = defaultConfig();
    runtimeConfig.advisorModel = 'claude';
    expect(registry.execute('advisor', '', context({ runtimeConfig }))).toEqual({
      type: 'show-modal',
      modal: 'advisor',
    });
  });

  it('stays interactive-only, so print mode refuses it rather than opening a picker', () => {
    const definition = BUILTIN_COMMAND_DEFINITIONS.find((command) => command.name === 'advisor');
    expect(definition).toBeDefined();
    expect(definition?.nonInteractive).toBeFalsy();
  });

  it('reports the advisor and its usage', () => {
    expect(registry.execute('advisor', 'status', context())).toEqual({
      type: 'local-message',
      content: 'Advisor: off\nUsage: /advisor <model> | off',
    });
    const runtimeConfig = defaultConfig();
    runtimeConfig.advisorModel = 'claude-opus-5-5';
    expect(registry.execute('advisor', 'status', context({ runtimeConfig }))).toMatchObject({
      content: 'Advisor: claude-opus-5-5\nUsage: /advisor <model> | off',
    });
  });

  it('reads every status word as a question, never as a model name', () => {
    for (const word of [
      'status',
      'STATUS',
      'list',
      'help',
      'version',
      'about',
      'show',
      '--help',
      '?',
    ]) {
      expect(registry.execute('advisor', word, context())).toMatchObject({
        type: 'local-message',
        content: 'Advisor: off\nUsage: /advisor <model> | off',
      });
    }
  });

  it('sets and clears the advisor model', () => {
    expect(registry.execute('advisor', 'claude-opus-5-5', context())).toEqual({
      type: 'set-advisor',
      model: 'claude-opus-5-5',
    });
    expect(registry.execute('advisor', 'off', context())).toEqual({
      type: 'set-advisor',
      model: null,
    });
  });

  // #418. A provider only the workspace declares is not in `settings.provider` until approved.
  describe('naming a workspace-declared provider (#418)', () => {
    const saved = Object.fromEntries(
      ['BOOK_API_KEY', 'BOOK_BASE_URL', 'BOOK_HOME', 'BOOK_MODEL', 'BOOK_ADVISOR_MODEL'].map(
        (name) => [name, process.env[name]],
      ),
    );
    const dirs: string[] = [];
    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const declaration = { type: 'openai', baseURL: 'https://lab.example/v1' } as const;

    function workspaceConfig() {
      const home = mkdtempSync(join(tmpdir(), 'book-builtins-home-'));
      const workspace = mkdtempSync(join(tmpdir(), 'book-builtins-ws-'));
      dirs.push(home, workspace);
      mkdirSync(join(workspace, '.book'));
      writeFileSync(
        join(workspace, '.book', 'settings.json'),
        JSON.stringify({ provider: { lab: declaration } }),
      );
      process.env.BOOK_HOME = home;
      process.env.BOOK_API_KEY = 'sk-test';
      delete process.env.BOOK_BASE_URL;
      delete process.env.BOOK_MODEL;
      delete process.env.BOOK_ADVISOR_MODEL;
      return { home, workspace };
    }

    // The id is the user's own selection: while the provider is pending it names none of theirs,
    // so it is a plain model id on the default endpoint, never the repository's origin (#418).
    it('accepts /advisor <workspace-provider>/<model> while pending as a plain id, not the workspace origin', () => {
      const { workspace } = workspaceConfig();
      const config = loadConfig(workspace);

      const effect = registry.execute('advisor', 'lab/adv', context({ runtimeConfig: config }));

      expect(effect).toEqual({ type: 'set-advisor', model: 'lab/adv' });
      const resolved = resolveAdvisorModelConfig({ ...config, advisorModel: 'lab/adv' });
      expect(resolved?.baseUrl).not.toBe(declaration.baseURL);
      expect(resolved?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('accepts it once the provider is approved', () => {
      const { home, workspace } = workspaceConfig();
      expect(
        persistWorkspaceProviderChoice(
          workspace,
          'lab',
          workspaceProviderFingerprint(declaration),
          'approved',
          join(home, 'trust.json'),
        ).ok,
      ).toBe(true);

      expect(
        registry.execute('advisor', 'lab/adv', context({ runtimeConfig: loadConfig(workspace) })),
      ).toEqual({ type: 'set-advisor', model: 'lab/adv' });
    });

    it('still turns the advisor off while the provider is pending', () => {
      const { workspace } = workspaceConfig();

      expect(
        registry.execute('advisor', 'off', context({ runtimeConfig: loadConfig(workspace) })),
      ).toEqual({ type: 'set-advisor', model: null });
    });
  });

  describe('with a main model on a configured provider and BOOK_API_KEY (#419)', () => {
    const runtimeConfig = () => {
      const config = defaultConfig({
        apiKey: 'sk-ant-test',
        defaultApiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com',
        defaultBaseUrl: 'https://api.openai.com/v1',
        defaultBaseUrlExplicit: false,
        model: 'claude-sonnet-5-5',
        modelSelection: 'anthropic/claude-sonnet-5-5',
      });
      config.settings.provider.anthropic = {
        type: 'anthropic',
        baseURL: 'https://api.anthropic.com',
        models: {},
      };
      return config;
    };

    it('refuses a bare id, saving nothing', () => {
      const effect = registry.execute(
        'advisor',
        'claude',
        context({ runtimeConfig: runtimeConfig() }),
      );
      expect(effect).toMatchObject({ type: 'local-message', isError: true });
      expect(effect).toHaveProperty('content', expect.stringContaining('use <provider>/<model>'));
    });

    it('still sets <provider>/<model> for a configured provider', () => {
      expect(
        registry.execute(
          'advisor',
          'anthropic/claude-opus-5-5',
          context({ runtimeConfig: runtimeConfig() }),
        ),
      ).toEqual({ type: 'set-advisor', model: 'anthropic/claude-opus-5-5' });
    });

    it('warns, still saving, when the id names a provider that is not configured', () => {
      const config = runtimeConfig();
      // A session on the default endpoint with the default key: the bare resolution is its own.
      config.baseUrl = 'https://api.openai.com/v1';
      const effect = registry.execute('advisor', 'antropic/x', context({ runtimeConfig: config }));
      expect(effect).toMatchObject({ type: 'set-advisor', model: 'antropic/x' });
      expect(effect).toHaveProperty('notice', expect.stringContaining('"antropic"'));
      // A configured provider carries no notice.
      expect(
        registry.execute('advisor', 'anthropic/x', context({ runtimeConfig: config })),
      ).toEqual({ type: 'set-advisor', model: 'anthropic/x' });
    });

    it('refuses a malformed id even with BOOK_BASE_URL set', () => {
      const config = runtimeConfig();
      config.defaultBaseUrlExplicit = true;
      for (const id of ['foo/', '/foo']) {
        expect(registry.execute('advisor', id, context({ runtimeConfig: config }))).toMatchObject({
          type: 'local-message',
          isError: true,
        });
      }
    });

    it('says in its status that a stored id would be refused', () => {
      const config = runtimeConfig();
      config.advisorModel = 'claude';
      const effect = registry.execute('advisor', 'status', context({ runtimeConfig: config }));
      expect(effect).toMatchObject({
        type: 'local-message',
        content: expect.stringMatching(
          /^Advisor: claude \(refused: advisor model "claude" names no configured provider/,
        ),
      });
      config.advisorModel = 'anthropic/claude-opus-5-5';
      expect(
        registry.execute('advisor', 'status', context({ runtimeConfig: config })),
      ).toMatchObject({
        content: 'Advisor: anthropic/claude-opus-5-5\nUsage: /advisor <model> | off',
      });
    });

    it('still turns the advisor off and reports its status', () => {
      expect(
        registry.execute('advisor', 'off', context({ runtimeConfig: runtimeConfig() })),
      ).toEqual({
        type: 'set-advisor',
        model: null,
      });
      expect(
        registry.execute('advisor', 'status', context({ runtimeConfig: runtimeConfig() })),
      ).toMatchObject({ type: 'local-message' });
    });
  });
});
