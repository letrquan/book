/**
 * Slash-command dispatch for hosts that have no interactive surface: print /
 * headless mode (`book -p …`) and the SDK.
 *
 * The TUI resolves a submitted `/name` in three ordered steps — the built-in
 * registry (`createBuiltinCommandRegistry`), then the user/project command
 * files (`discoverCommands`), then "not a command, send the text as typed".
 * This module walks the same three steps against the same registries and the
 * same `resolveCommandBody`, so print mode cannot fork command semantics. What
 * differs is only what a non-interactive host may do with the resulting effect.
 *
 * A print host can send a prompt. It cannot open a modal, toggle a panel,
 * switch themes, or resume a session, so a command whose effect needs an
 * interactive host is refused *before* its `execute` runs: several built-ins
 * write settings or files as a side effect (`/config`, `/export`, `/memory
 * approve`), and running one only to discover the host cannot show its result
 * would be worse than not running it at all. The gate is the declarative
 * `nonInteractive` flag on the command definition, never a guess about the
 * effect a given argument string happens to produce.
 */

import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { CommandContext, SlashCommand } from '../types/commands.js';
import { commandEnforcementContext, parseSlashInput, resolveCommandBody } from './resolve.js';
import { discoverCommands } from './loader.js';
import {
  createBuiltinCommandRegistry,
  type BuiltinCommandContext,
  type BuiltinCommandEffect,
} from './builtins.js';
import type { CommandRegistry } from './registry.js';
import type { AgentManager } from '../agents/manager.js';
import type { AgentRunContext } from '../types/runs.js';
import { reviewRunnerFor } from '../review/runner.js';
import { reviewReportJson, runHostReview } from '../review/host.js';

export type BuiltinPrintRegistry = CommandRegistry<BuiltinCommandContext, BuiltinCommandEffect>;

/** Ambient facts a non-interactive host can state truthfully about its run. */
export interface PrintCommandEnvironment {
  /** Frozen run config; supplies workspace, model, and provider. */
  config: AgentConfig;
  /** Permission mode of the run. */
  mode: PermissionMode;
  /** Session the command is resolved against (`${BOOK_SESSION_ID}`). */
  sessionId: string;
  /** Cancels in-flight shell substitution, exactly as the TUI's does. */
  signal?: AbortSignal;
  /**
   * The managed-agent runtime for commands the host performs by running agents
   * rather than by sending a prompt (`/review`), together with the run those
   * agents belong to. A host that omits it refuses those commands instead of
   * pretending.
   *
   * `manager` is a factory so an ordinary print run never pays to build one, and
   * `runContext` is required alongside it rather than optional: budget
   * enforcement is keyed by `rootRunId` (`RunAccounting.checkBeforeModelCall`),
   * so a manager supplied without one would spawn agents under a fresh, unbudgeted
   * root and quietly spend past `--max-budget-usd`. Coupling them in one field
   * makes that combination unrepresentable.
   */
  agents?: {
    manager: () => AgentManager;
    runContext: AgentRunContext;
  };
}

/** What the host should do with one submitted line. */
export type PrintCommandDispatch =
  /** Run this text as the user turn. Set for prompt-body commands. */
  | {
      kind: 'prompt';
      prompt: string;
      /** Frontmatter enforcement (allowed-tools / model), as the TUI passes it. */
      commandContext?: CommandContext;
      /** Non-fatal shell-substitution failures, exactly as the TUI collects them. */
      shellErrors?: string[];
    }
  /** The effect handler already did the work; the host runs no model turn. */
  | {
      kind: 'handled';
      command: string;
      /** Human-readable rendering, used by `--output-format text`. */
      output?: string;
      /**
       * Machine-readable rendering for `--output-format json` / `stream-json`.
       * A maintained output contract: see `review/host.ts#ReviewJsonReport`.
       */
      data?: unknown;
    }
  /** Not a command: send the line to the model unchanged. */
  | { kind: 'passthrough'; prompt: string };

/**
 * Performs one built-in effect in a non-interactive host. Returning `handled`
 * means the work is done and no model turn should run for this input. The third
 * argument is the name the user actually typed (an alias, possibly), so a
 * handler can name it in an error.
 */
export type PrintEffectHandler<Type extends BuiltinCommandEffect['type']> = (
  effect: Extract<BuiltinCommandEffect, { type: Type }>,
  env: PrintCommandEnvironment,
  command: string,
) => PrintCommandDispatch | Promise<PrintCommandDispatch>;

type AnyPrintEffectHandler = (
  effect: BuiltinCommandEffect,
  env: PrintCommandEnvironment,
  command: string,
) => PrintCommandDispatch | Promise<PrintCommandDispatch>;

/**
 * Effect-type → handler map. An effect with no registered handler is refused
 * loudly rather than degraded into "send the slash string to the model".
 */
export class PrintEffectRegistry {
  private readonly handlers = new Map<BuiltinCommandEffect['type'], AnyPrintEffectHandler>();

  register<Type extends BuiltinCommandEffect['type']>(
    type: Type,
    handler: PrintEffectHandler<Type>,
  ): this {
    // Sound in this direction: the stored handler is only ever invoked with an
    // effect whose `type` matches the key it was registered under.
    this.handlers.set(type, handler as AnyPrintEffectHandler);
    return this;
  }

  has(type: BuiltinCommandEffect['type']): boolean {
    return this.handlers.has(type);
  }

  handledTypes(): BuiltinCommandEffect['type'][] {
    return [...this.handlers.keys()];
  }

  handle(
    effect: BuiltinCommandEffect,
    env: PrintCommandEnvironment,
    command: string,
  ): Promise<PrintCommandDispatch> | undefined {
    const handler = this.handlers.get(effect.type);
    return handler ? Promise.resolve(handler(effect, env, command)) : undefined;
  }
}

/** A slash command exists but this host cannot run it. Never falls back to prose. */
export class UnsupportedPrintCommandError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = 'UnsupportedPrintCommandError';
    this.command = command;
  }
}

/**
 * The command ran and rejected its own invocation (bad flag, bad argument).
 *
 * Separate from {@link UnsupportedPrintCommandError} because the command *is*
 * supported here; it is the arguments that are wrong. Both end the run non-zero:
 * a print host that printed "✕ Unknown review option: --dep" and exited 0 would
 * let a CI job believe a review it never ran had passed.
 */
export class PrintCommandUsageError extends Error {
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.name = 'PrintCommandUsageError';
    this.command = command;
  }
}

/**
 * Why `--fix` stops here rather than running unattended.
 *
 * `applyReviewFixes` spawns patcher agents that edit files and then commits the
 * verified patch into the user's repository. A non-interactive host cannot
 * answer a managed-agent permission prompt — `AgentManager` denies every one
 * when no interactive host is attached — so an unattended `--fix` would either
 * fail every patch on a denial or, under `--permission-mode bypassPermissions`,
 * commit unreviewed changes with nobody watching. The read-only review is wired
 * end to end; the applying half stays where a human can see it.
 */
const FIX_REFUSAL = [
  '✕ /review --fix needs an interactive session.',
  '',
  '--fix spawns patcher agents that edit files and commit verified patches. A non-interactive',
  'host cannot approve those tool calls, so the fix pass would either be denied outright or',
  'commit unreviewed changes with no one watching.',
  '',
  'Run `book` interactively and use /review --fix there, or run `book -p "/review --deep"`',
  'and apply the reported fixes yourself.',
].join('\n');

/**
 * Run `/review` from a host with no interactive surface.
 *
 * The target is resolved host-side by the pipeline (`runHostReview` →
 * `resolveReviewTarget`) from `env.config.workspace` and the parsed scope, so
 * `--base`, path scoping and `<base>...<head>` behave exactly as in the TUI and
 * the reviewer agents still get an immutable diff they cannot re-select.
 */
async function performPrintReview(
  effect: Extract<BuiltinCommandEffect, { type: 'review' }>,
  env: PrintCommandEnvironment,
  command: string,
): Promise<PrintCommandDispatch> {
  if (effect.scope.fix) throw new UnsupportedPrintCommandError(command, FIX_REFUSAL);
  if (!env.agents) {
    throw new UnsupportedPrintCommandError(
      command,
      `✕ /${command} needs the managed-agent runtime, and this host did not provide one.`,
    );
  }

  const result = await runHostReview({
    scope: effect.scope,
    workspace: env.config.workspace,
    // Every reviewer, lens and verifier agent is spawned under the host's run,
    // so the whole pipeline is billed and budgeted as one root.
    runner: reviewRunnerFor(env.agents.manager(), {
      rootRunId: env.agents.runContext.rootRunId,
      parentRunId: env.agents.runContext.runId,
    }),
  });
  // A review that could not run at all must end the run non-zero. An
  // inconclusive *verdict* is different: the review ran, its coverage warnings
  // are in the report, and the caller gates on `verdict`.
  if (result.error) throw new Error(result.segments.join('\n\n'));
  return {
    kind: 'handled',
    command,
    output: result.segments.join('\n\n'),
    data: reviewReportJson(result),
  };
}

/**
 * The effects a plain print host can perform on its own: send a prompt, print a
 * message the command produced, and run the host-orchestrated review. Anything
 * that needs to mutate host state or open a surface stays unregistered, and an
 * unregistered effect is refused rather than degraded.
 */
export function createPrintEffectRegistry(): PrintEffectRegistry {
  return new PrintEffectRegistry()
    .register('send-prompt', (effect) => ({
      kind: 'prompt',
      prompt: effect.prompt,
      commandContext: effect.context,
    }))
    .register('local-message', (effect, _env, command) => {
      if (effect.isError) throw new PrintCommandUsageError(command, effect.content);
      return { kind: 'handled', command, output: effect.content };
    })
    .register('review', performPrintReview);
}

export interface PrintCommandDeps {
  /** Defaults to the shared built-in registry the TUI uses. */
  builtins?: BuiltinPrintRegistry;
  /** Defaults to the `send-prompt`-only registry. */
  effects?: PrintEffectRegistry;
  /** Defaults to `discoverCommands(workspace)` — the TUI's loader. */
  commands?: SlashCommand[];
}

/**
 * Context handed to a built-in's `execute` in print mode.
 *
 * Only fields a non-interactive host knows are populated; conversation state
 * is empty because resolution happens before the turn exists. A command may
 * therefore be marked `nonInteractive` only when it depends on nothing beyond
 * workspace, session id, model, provider, permission mode, and config.
 */
function printBuiltinContext(
  env: PrintCommandEnvironment,
  commands: SlashCommand[],
): BuiltinCommandContext {
  return {
    workspace: env.config.workspace,
    sessionId: env.sessionId,
    model: env.config.model,
    provider: env.config.provider,
    currentTurn: 0,
    messages: [],
    lastError: null,
    runtimeConfig: env.config,
    mode: env.mode,
    usage: null,
    turnDurationMs: 0,
    contextHistory: [],
    compactBoundaries: [],
    commandCount: commands.length,
    skillCount: 0,
    resolveAmbientContext: () => ({
      subagentCount: 0,
      hasMemoryIndex: false,
      hasClaudeMdLoader: false,
    }),
  };
}

function supportedCommandHelp(builtins: BuiltinPrintRegistry, commands: SlashCommand[]): string[] {
  const lines = ['Commands supported in print mode:'];
  for (const definition of builtins.getDefinitions()) {
    if (definition.nonInteractive) lines.push(`  /${definition.name} — ${definition.description}`);
  }
  const custom = commands.map((command) => `/${command.name}`);
  lines.push(
    custom.length > 0
      ? `  custom commands from .book/commands: ${custom.slice(0, 12).join(' ')}${custom.length > 12 ? ' …' : ''}`
      : '  plus any custom command in .book/commands/ or ~/.book/commands/',
  );
  return lines;
}

function unsupported(
  command: string,
  reason: string,
  builtins: BuiltinPrintRegistry,
  commands: SlashCommand[],
): UnsupportedPrintCommandError {
  return new UnsupportedPrintCommandError(
    command,
    [
      `✕ /${command} ${reason}`,
      '',
      ...supportedCommandHelp(builtins, commands),
      '',
      `Run book without --print (interactive mode) to use /${command}.`,
    ].join('\n'),
  );
}

/**
 * Resolve one submitted line for a non-interactive host.
 *
 * Throws {@link UnsupportedPrintCommandError} when the line names a real
 * command this host cannot perform. An unknown `/name` is not a command at all
 * — the TUI sends it to the model unchanged, and so does this.
 */
export async function resolvePrintCommand(
  input: string,
  env: PrintCommandEnvironment,
  deps: PrintCommandDeps = {},
): Promise<PrintCommandDispatch> {
  const parsed = parseSlashInput(input);
  if (!parsed || !parsed.name) return { kind: 'passthrough', prompt: input };

  const builtins = deps.builtins ?? createBuiltinCommandRegistry();
  const effects = deps.effects ?? createPrintEffectRegistry();
  const commands = deps.commands ?? discoverCommands(env.config.workspace);
  const context = printBuiltinContext(env, commands);

  const resolved = builtins.resolve(parsed.name, context);
  if (resolved) {
    if (!resolved.definition.nonInteractive) {
      throw unsupported(
        parsed.name,
        'needs an interactive session: it changes host state instead of producing a prompt.',
        builtins,
        commands,
      );
    }
    if (!resolved.available) {
      throw unsupported(
        parsed.name,
        `is unavailable: ${resolved.unavailableReason ?? 'no reason given'}`,
        builtins,
        commands,
      );
    }
    const effect = resolved.definition.execute(
      { name: resolved.invokedName, rawArguments: parsed.rawArguments },
      context,
    );
    const dispatch = await effects.handle(effect, env, resolved.invokedName);
    if (!dispatch) {
      throw unsupported(
        parsed.name,
        `resolved to the '${effect.type}' effect, which a non-interactive host cannot perform.`,
        builtins,
        commands,
      );
    }
    return dispatch.kind === 'handled' ? { ...dispatch, command: parsed.name } : dispatch;
  }

  const custom = commands.find((command) => command.name === parsed.name);
  if (!custom) return { kind: 'passthrough', prompt: input };

  // Same resolver, same order (shell substitution, then variables), same trust
  // model as the TUI. A repository-declared body that substitutes shell is
  // refused here exactly as it is there: this host cannot prompt for the
  // decision, so an unapproved command ends the run instead of running its
  // shell unattended.
  const { resolved: body, shellErrors } = await resolveCommandBody(
    custom,
    parsed.rawArguments,
    {
      sessionId: env.sessionId,
      workspace: env.config.workspace,
      model: env.config.model,
      projectCommands: env.config.settings.commands.projectCommands,
    },
    env.signal,
  );
  return {
    kind: 'prompt',
    prompt: body,
    commandContext: commandEnforcementContext(custom, body),
    shellErrors,
  };
}
