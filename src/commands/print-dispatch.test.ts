import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPrintEffectRegistry,
  PrintEffectRegistry,
  resolvePrintCommand,
  PrintCommandUsageError,
  UnsupportedPrintCommandError,
  type BuiltinPrintRegistry,
  type PrintCommandDispatch,
  type PrintCommandEnvironment,
} from './print-dispatch.js';
import {
  BUILTIN_COMMAND_DEFINITIONS,
  type BuiltinCommandContext,
  type BuiltinCommandDefinition,
  type BuiltinCommandEffect,
} from './builtins.js';
import { CommandRegistry } from './registry.js';
import { discoverCommands } from './loader.js';
import { projectCommandFingerprint, type ProjectCommandStore } from '../command-approvals.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { getProjectMemoryDir } from '../memory-store.js';
import { deriveSessionName } from '../session/name.js';

let tempDirs: string[] = [];

// Keep the developer's own ~/.book/commands out of every discovery call.
isolateBookHome('book-print-home-');

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'book-print-dispatch-'));
  tempDirs.push(workspace);
  return workspace;
}

function writeCommand(workspace: string, name: string, contents: string): void {
  const dir = join(workspace, '.book', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), contents, 'utf-8');
}

/** Decisions approving exactly what each named command body runs today. */
function approving(workspace: string, ...names: string[]): ProjectCommandStore {
  const store: ProjectCommandStore = {};
  for (const command of discoverCommands(workspace)) {
    if (!names.includes(command.name)) continue;
    store[command.name] = {
      fingerprint: projectCommandFingerprint(command.body),
      choice: 'approved',
    };
  }
  return store;
}

function env(
  workspace: string,
  projectCommands: ProjectCommandStore = {},
): PrintCommandEnvironment {
  const config = defaultConfig({ workspace, model: 'test-model' });
  config.settings.commands.projectCommands = projectCommands;
  return {
    config,
    mode: 'default',
    sessionId: 'session-print-1',
  };
}

/**
 * Built-in registry with one definition patched. Copies rather than mutating:
 * `BUILTIN_COMMAND_DEFINITIONS` is module-level shared state.
 */
function builtinsWith(
  name: string,
  patch: Partial<BuiltinCommandDefinition>,
): BuiltinPrintRegistry {
  const registry = new CommandRegistry<BuiltinCommandContext, BuiltinCommandEffect>();
  registry.registerAll(
    BUILTIN_COMMAND_DEFINITIONS.map((definition) =>
      definition.name === name ? { ...definition, ...patch } : definition,
    ),
  );
  return registry;
}

describe('resolvePrintCommand — prompt-body commands', () => {
  it('expands a built-in prompt command into its body and tool allowlist', async () => {
    const workspace = tempWorkspace();

    const dispatch = await resolvePrintCommand('/security-review auth paths', env(workspace));

    expect(dispatch.kind).toBe('prompt');
    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).toContain('Perform a security review');
    // The argument reaches the prompt, so the scope is not silently dropped.
    expect(dispatch.prompt).toContain('auth paths');
    expect(dispatch.prompt).not.toBe('/security-review auth paths');
    expect(dispatch.commandContext?.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'WebSearch',
    ]);
  });

  it('expands /init through the same registry the TUI uses', async () => {
    const workspace = tempWorkspace();

    const dispatch = await resolvePrintCommand('/init', env(workspace));

    expect(dispatch.kind).toBe('prompt');
    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).toContain('CLAUDE.md');
    expect(dispatch.commandContext?.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Write']);
  });

  it('resolves a project command body with arguments, named args, and env vars', async () => {
    const workspace = tempWorkspace();
    writeCommand(
      workspace,
      'triage',
      [
        '---',
        'description: Triage an issue',
        'arguments: area, severity',
        '---',
        'Triage $area at $severity in ${BOOK_WORKSPACE} using ${BOOK_MODEL} ($ARGUMENTS)',
      ].join('\n'),
    );

    const dispatch = await resolvePrintCommand('/triage parser high', env(workspace));

    expect(dispatch).toEqual({
      kind: 'prompt',
      prompt: `Triage parser at high in ${workspace} using test-model (parser high)`,
      commandContext: undefined,
      // Named after what was typed, not the substituted body (#524).
      sessionNameSource: '/triage parser high',
      shellErrors: [],
    });
  });

  it('carries allowed-tools and model frontmatter into the command context', async () => {
    const workspace = tempWorkspace();
    writeCommand(
      workspace,
      'audit',
      ['---', 'allowed-tools: [Read, Grep]', 'model: openai/gpt-5', '---', 'Audit $1'].join('\n'),
    );

    const dispatch = await resolvePrintCommand('/audit src', env(workspace));

    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.commandContext).toEqual({
      command: expect.objectContaining({ name: 'audit' }),
      resolvedBody: 'Audit src',
      modelOverride: 'openai/gpt-5',
      allowedTools: ['Read', 'Grep'],
    });
  });

  it('runs approved shell substitution as the TUI does and reports its failures', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'ctx', 'Context: !`echo hello-from-shell`');
    writeCommand(workspace, 'broken', 'Context: !`exit 3`');
    const decided = approving(workspace, 'ctx', 'broken');

    const ok = await resolvePrintCommand('/ctx', env(workspace, decided));
    if (ok.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(ok.prompt).toBe('Context: hello-from-shell');
    expect(ok.shellErrors).toEqual([]);

    const failed = await resolvePrintCommand('/broken', env(workspace, decided));
    if (failed.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    // Same non-fatal placeholder the TUI injects — neither widened nor swallowed.
    expect(failed.prompt).toContain('[shell error:');
    expect(failed.shellErrors?.length).toBe(1);
  });

  it('refuses a repository command whose shell was never approved', async () => {
    // The exposure this gate closes: a clone plus `book -p "/name"` was a
    // shell on the host, with no terminal present to notice.
    const workspace = tempWorkspace();
    writeCommand(workspace, 'ctx', 'Context: !`echo pwned`');

    await expect(resolvePrintCommand('/ctx', env(workspace))).rejects.toThrow(
      /has not been approved/,
    );
  });

  it('still runs a repository command that substitutes no shell', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'plain', 'Summarise $1');

    const dispatch = await resolvePrintCommand('/plain src', env(workspace));
    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).toBe('Summarise src');
  });

  // `/queue` is the TUI's own state, listed in its menu but not a command a print host or the
  // model knows: print mode treats the name as it did before `/queue` joined the catalog.
  it('runs a project command named queue, since /queue belongs to the TUI alone', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'queue', 'Summarise the release queue.');

    const dispatch = await resolvePrintCommand('/queue', env(workspace));

    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).toBe('Summarise the release queue.');
  });

  it('sends a bare /queue unchanged when no command claims it', async () => {
    const workspace = tempWorkspace();
    expect(await resolvePrintCommand('/queue', env(workspace))).toEqual({
      kind: 'passthrough',
      prompt: '/queue',
    });
  });

  it('prefers a built-in over a same-named project command, like the TUI', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'init', 'Custom init body that must not win.');

    const dispatch = await resolvePrintCommand('/init', env(workspace));

    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).not.toContain('must not win');
  });
});

describe('resolvePrintCommand — non-commands pass through', () => {
  it('sends plain prose unchanged', async () => {
    const workspace = tempWorkspace();
    expect(await resolvePrintCommand('summarize the diff', env(workspace))).toEqual({
      kind: 'passthrough',
      prompt: 'summarize the diff',
    });
  });

  it('sends an unknown /name unchanged instead of failing', async () => {
    const workspace = tempWorkspace();
    expect(await resolvePrintCommand('/etc/hosts is a file', env(workspace))).toEqual({
      kind: 'passthrough',
      prompt: '/etc/hosts is a file',
    });
  });

  it('treats a bare slash as prose', async () => {
    const workspace = tempWorkspace();
    expect(await resolvePrintCommand('/ what is this', env(workspace))).toEqual({
      kind: 'passthrough',
      prompt: '/ what is this',
    });
  });
});

describe('resolvePrintCommand — host effects fail loudly', () => {
  it('refuses an interactive built-in with an actionable error and never sends the slash string', async () => {
    const workspace = tempWorkspace();

    const error = await resolvePrintCommand('/clear', env(workspace)).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    const failure = error as UnsupportedPrintCommandError;
    expect(failure.command).toBe('clear');
    expect(failure.message).toContain('/clear');
    expect(failure.message).toContain('Commands supported in print mode:');
    expect(failure.message).toContain('/init');
    expect(failure.message).toContain('/security-review');
    expect(failure.message).toContain('Run book without --print');
  });

  it('lists the workspace commands that do work in print mode', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'triage', 'Triage $ARGUMENTS');

    const error = (await resolvePrintCommand('/model gpt-5', env(workspace)).catch(
      (thrown) => thrown,
    )) as UnsupportedPrintCommandError;

    expect(error.message).toContain('/triage');
  });

  // `/review` is absent on purpose: it is host-orchestrated and now has a print
  // handler (see print-dispatch.review.test.ts). Everything here still refuses.
  it.each(['clear', 'new', 'resume', 'compact', 'exit', 'config', 'memory', 'jobs', 'rewind'])(
    'refuses /%s rather than sending it as prose',
    async (command) => {
      const workspace = tempWorkspace();
      await expect(resolvePrintCommand(`/${command}`, env(workspace))).rejects.toBeInstanceOf(
        UnsupportedPrintCommandError,
      );
    },
  );

  describe('/memory', () => {
    function withMemory(workspace: string): string {
      const dir = getProjectMemoryDir(workspace);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.format'), '2\n');
      writeFileSync(
        join(dir, 'a.md'),
        '---\nname: a\ndescription: d\nmetadata:\n  type: project\n---\nBody.\n',
      );
      return dir;
    }

    it('runs `consolidate` headlessly, as a prompt with the restricted tools', async () => {
      const workspace = tempWorkspace();
      const dir = withMemory(workspace);

      const dispatch = await resolvePrintCommand(
        '/memory consolidate the build notes',
        env(workspace),
      );

      expect(dispatch.kind).toBe('prompt');
      if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
      expect(dispatch.prompt).toContain(join(dir, 'MEMORY.md'));
      expect(dispatch.prompt).toContain('concentrate on: the build notes');
      // Rules are written with `/` on every platform.
      expect(dispatch.commandContext?.allowedTools).toContain(
        `Bash(rm ${dir.replaceAll('\\', '/')}/*.md)`,
      );
      expect(dispatch.commandContext?.allowedTools).not.toContain('ApplyPatch');
    });

    it('refuses every other /memory form', async () => {
      const workspace = tempWorkspace();
      const dir = withMemory(workspace);
      for (const form of [
        '/memory',
        '/memory status',
        '/memory path',
        '/memory on',
        '/memory off',
        '/memory delete a.md',
        '/memory consolidates',
        '/memory delete consolidate',
      ]) {
        await expect(resolvePrintCommand(form, env(workspace)), form).rejects.toBeInstanceOf(
          UnsupportedPrintCommandError,
        );
      }
      // Refused before `execute` ran: the file `delete` would have removed is still there.
      expect(existsSync(join(dir, 'a.md'))).toBe(true);
    });

    it('lists it among the supported commands in the refusal', async () => {
      const workspace = tempWorkspace();
      const error = (await resolvePrintCommand('/memory path', env(workspace)).catch(
        (thrown) => thrown,
      )) as UnsupportedPrintCommandError;
      expect(error.message).toContain('/memory consolidate');
    });

    it('fails the run when consolidating is refused, rather than exiting 0', async () => {
      const workspace = tempWorkspace(); // no memory files
      await expect(
        resolvePrintCommand('/memory consolidate', env(workspace)),
      ).rejects.toBeInstanceOf(PrintCommandUsageError);
    });
  });

  it('never executes an interactive built-in, so its side effects cannot fire', async () => {
    const workspace = tempWorkspace();

    await expect(resolvePrintCommand('/config maxTurns=12', env(workspace))).rejects.toBeInstanceOf(
      UnsupportedPrintCommandError,
    );

    // /config writes .book/settings.local.json the moment it executes.
    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);
  });

  it('refuses a nonInteractive command whose effect has no registered handler', async () => {
    const workspace = tempWorkspace();

    // Marking a command runnable without wiring a handler for the effect it
    // produces must fail loudly rather than fall through to the model.
    const error = (await resolvePrintCommand('/clear', env(workspace), {
      builtins: builtinsWith('clear', { nonInteractive: true }),
    }).catch((thrown) => thrown)) as UnsupportedPrintCommandError;

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect(error.message).toContain("'start-new-conversation' effect");
  });

  it('refuses a command whose availability check fails', async () => {
    const workspace = tempWorkspace();

    const error = (await resolvePrintCommand('/init', env(workspace), {
      builtins: builtinsWith('init', {
        nonInteractive: true,
        availability: () => ({ available: false, reason: 'index is rebuilding' }),
      }),
    }).catch((thrown) => thrown)) as UnsupportedPrintCommandError;

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect(error.message).toContain('index is rebuilding');
  });
});

describe('PrintEffectRegistry', () => {
  it('handles exactly the effects a print host can perform itself', () => {
    const registry = createPrintEffectRegistry();
    expect(registry.handledTypes()).toEqual([
      'send-prompt',
      'local-message',
      'review',
      // Both refuse unless the host supplies `goal`, so they still fail closed there.
      'set-goal',
      'clear-goal',
    ]);
    // Host-state effects stay unhandled, so they keep failing closed.
    expect(registry.has('start-new-conversation')).toBe(false);
    expect(registry.has('show-modal')).toBe(false);
    expect(registry.has('compact')).toBe(false);
  });

  it('routes a registered effect to its handler and stamps the invoked name', async () => {
    const workspace = tempWorkspace();
    const handler = vi.fn(
      (
        effect: Extract<BuiltinCommandEffect, { type: 'review' }>,
        environment: PrintCommandEnvironment,
      ): PrintCommandDispatch => ({
        kind: 'handled',
        command: 'ignored — the dispatcher stamps the invoked name',
        output: `reviewed ${effect.scope.base ?? 'working tree'} in ${environment.config.workspace}`,
      }),
    );

    const dispatch = await resolvePrintCommand('/review --base main', env(workspace), {
      builtins: builtinsWith('review', { nonInteractive: true }),
      effects: createPrintEffectRegistry().register('review', handler),
    });

    expect(dispatch).toEqual({
      kind: 'handled',
      command: 'review',
      output: `reviewed main in ${workspace}`,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not rediscover commands when the caller supplies them', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'triage', 'Triage $ARGUMENTS');
    const commands = discoverCommands(workspace);

    const dispatch = await resolvePrintCommand('/triage now', env(workspace), { commands });

    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    expect(dispatch.prompt).toBe('Triage now');
  });

  it('is an instance-scoped map, so registration cannot leak between hosts', () => {
    const first = new PrintEffectRegistry().register('review', () => ({
      kind: 'handled',
      command: 'review',
    }));
    expect(first.has('review')).toBe(true);
    expect(new PrintEffectRegistry().has('review')).toBe(false);
  });
});

// #524: a prompt-body command names the session after what the user typed, not the body it made.
describe('resolvePrintCommand — session name source', () => {
  const promptDispatch = (dispatch: PrintCommandDispatch) => {
    if (dispatch.kind !== 'prompt') throw new Error('expected a prompt dispatch');
    return dispatch;
  };

  it('is the typed line for a built-in prompt command, so /init names the session "Init"', async () => {
    const dispatch = promptDispatch(await resolvePrintCommand('/init', env(tempWorkspace())));

    expect(dispatch.sessionNameSource).toBe('/init');
    expect(deriveSessionName(dispatch.sessionNameSource!)).toBe('Init');
    expect(deriveSessionName(dispatch.prompt)).not.toBe('Init');
  });

  it('is the raw line, arguments unsubstituted, for a custom command', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'deploy', 'Roll out to the $1 environment and report.');

    const dispatch = promptDispatch(
      await resolvePrintCommand('/deploy staging', env(workspace, approving(workspace, 'deploy'))),
    );

    expect(dispatch.prompt).toBe('Roll out to the staging environment and report.');
    expect(dispatch.sessionNameSource).toBe('/deploy staging');
    expect(deriveSessionName(dispatch.sessionNameSource!)).toBe('Deploy staging');
  });

  it('takes the line as typed, not as shell-substituted', async () => {
    const workspace = tempWorkspace();
    writeCommand(workspace, 'note', 'Note: $ARGUMENTS');

    const dispatch = promptDispatch(
      await resolvePrintCommand('/note $HOME is set', env(workspace)),
    );

    expect(dispatch.sessionNameSource).toBe('/note $HOME is set');
  });

  it('leaves a passthrough alone: an ordinary prompt names the session after itself', async () => {
    expect(await resolvePrintCommand('fix the build', env(tempWorkspace()))).toEqual({
      kind: 'passthrough',
      prompt: 'fix the build',
    });
  });
});

describe('resolvePrintCommand — /goal', () => {
  function goalEnv(workspace: string) {
    let goal: { condition: string } | undefined;
    const base = env(workspace);
    return {
      env: {
        ...base,
        goal: {
          get: () => undefined,
          set: (condition: string) => {
            goal = { condition };
          },
          clear: () => {
            const cleared = goal;
            goal = undefined;
            return cleared
              ? { ...cleared, iterations: 0, setAt: 0, origin: 'user' as const, outputTokens: 0 }
              : undefined;
          },
        },
      } satisfies PrintCommandEnvironment,
      current: () => goal,
    };
  }

  it('sets the goal and runs the kickoff turn', async () => {
    const { env: goalHost, current } = goalEnv(tempWorkspace());
    const dispatch = await resolvePrintCommand('/goal npm test exits 0', goalHost);
    expect(current()).toEqual({ condition: 'npm test exits 0' });
    expect(dispatch.kind).toBe('prompt');
    const prompt = (dispatch as Extract<PrintCommandDispatch, { kind: 'prompt' }>).prompt;
    expect(prompt).toContain(
      'A session-scoped Stop hook is now active with condition: "npm test exits 0"',
    );
    // A new session is named after the condition, not the kickoff (#431).
    expect(dispatch).toMatchObject({ sessionNameSource: 'npm test exits 0' });
  });

  it('clears the goal without a model turn', async () => {
    const { env: goalHost } = goalEnv(tempWorkspace());
    await resolvePrintCommand('/goal tests pass', goalHost);
    const dispatch = await resolvePrintCommand('/goal clear', goalHost);
    expect(dispatch).toMatchObject({ kind: 'handled', output: 'Goal cleared: tests pass' });
  });

  it('refuses /goal in a host that does not check goals', async () => {
    await expect(
      resolvePrintCommand('/goal tests pass', env(tempWorkspace())),
    ).rejects.toBeInstanceOf(UnsupportedPrintCommandError);
  });
});
