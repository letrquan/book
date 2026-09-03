import { writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { CommandContext } from '../types/commands.js';
import type { LocalCommandDisplay, Message, Usage } from '../types/messages.js';
import type { CompactBoundary } from '../types/sessions.js';
import { buildInitPrompt } from './init-prompt.js';
import { buildSecurityReviewPrompt, SECURITY_REVIEW_TOOLS } from './builtins-prompts.js';
import { parseReviewScope, REVIEW_USAGE } from '../review/scope.js';
import type { ReviewScope } from '../review/types.js';
import { CommandRegistry, type CommandAlias, type CommandDefinition } from './registry.js';
import { buildReleaseNotesReport, writeFeedbackReport } from '../version-info.js';
import { EFFORT_USAGE, isEffortLevel, type EffortLevel } from './effort.js';
import { redactSettingValue } from '../settings-redaction.js';
import { formatSettingsKeyHelp } from '../settings-repository.js';
import { buildMemoryInboxReport, buildMemoryReport } from '../memory-display.js';
import {
  approveMemoryCandidate,
  discardMemoryCandidate,
  getProjectMemoryDir,
  listMemoryCandidates,
  loadMemoryContext,
} from '../memory-store.js';
import { costReport, failureTotal, PRICING, usageReport } from '../pricing.js';
import { buildContextBreakdown, buildContextReport } from '../context-report.js';
import { resolveContextLimit, hasDeclaredContextWindow } from '../models.js';
import type { SkillRegistrySnapshot } from '../skill-registry.js';
import { buildSkillReport } from '../skill-report.js';
import { buildMcpStatusReport } from '../mcp-report.js';
import type { McpHostSnapshot } from '../mcp-host.js';
import { settingsScopeLabel, type SettingsScope } from '../settings-scope.js';
import { applySettingWrite, describeSettingShadow, guardSettingWrite } from '../settings-write.js';
import { normalizePermissionMode } from '../permission-mode.js';
import { listAuthProfiles, resolveAuthProfile } from '../auth/profiles.js';

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Hide from / autocomplete when empty, but still match when typed exactly. */
  isHidden?: boolean;
}

export interface BuiltinCommandContext {
  workspace: string;
  sessionId: string;
  model: string;
  provider?: string;
  currentTurn: number;
  messages: Message[];
  lastError?: string | null;
  effortUnavailableError?: string;
  runtimeConfig: AgentConfig;
  mode: string;
  usage: Usage | null;
  turnDurationMs: number;
  contextHistory: Message[];
  compactBoundaries: CompactBoundary[];
  commandCount: number;
  skillCount: number;
  skillSnapshot?: SkillRegistrySnapshot;
  mcpSnapshot?: McpHostSnapshot;
  /** Per-session tool call/failure counters keyed by canonical tool name. */
  toolCallStats?: ReadonlyMap<string, { calls: number; failures: Record<string, number> }>;
  resolveAmbientContext: () => {
    subagentCount: number;
    hasMemoryIndex: boolean;
    hasClaudeMdLoader: boolean;
  };
}

export type BuiltinCommandEffect =
  | { type: 'send-prompt'; prompt: string; context: CommandContext }
  | {
      type: 'local-message';
      content: string;
      display?: LocalCommandDisplay;
      refreshMemory?: boolean;
      /**
       * The command rejected its own invocation (bad flag, bad argument). An
       * interactive host just shows `content`; a non-interactive host must fail
       * the run instead of exiting 0 on a typo that silently changed nothing.
       */
      isError?: boolean;
    }
  | { type: 'start-new-conversation'; previousName?: string }
  | { type: 'resume-conversation'; session?: string }
  | { type: 'compact'; focus?: string }
  | { type: 'exit' }
  | {
      type: 'show-modal';
      modal: 'config' | 'model' | 'rewind' | 'theme' | 'effort' | 'skills' | 'login';
      /** Profile `/login <profile>` named, preselected in the picker. */
      profile?: string;
    }
  | { type: 'set-theme'; preference: string }
  | { type: 'set-model'; selection: string }
  | { type: 'set-effort'; level: EffortLevel }
  | { type: 'set-compact-model'; model: string }
  | { type: 'set-default-permission-mode'; mode: PermissionMode }
  | { type: 'set-show-thinking'; enabled: boolean }
  | { type: 'set-startup-animation'; enabled: boolean }
  | { type: 'set-memory-auto-save'; enabled: boolean }
  | { type: 'toggle-panel'; panel: 'help' | 'status' | 'permissions' }
  | { type: 'add-task'; subject: string }
  | { type: 'show-diff' }
  | { type: 'reload-assets' }
  | {
      type: 'review';
      scope: ReviewScope;
    }
  | {
      type: 'managed-agent';
      operation: 'list' | 'get' | 'send' | 'stop' | 'apply' | 'import';
      agentId?: string;
      message?: string;
      evidenceId?: string;
      importPath?: string;
      confirmed?: boolean;
    };

export type BuiltinCommandDefinition = CommandDefinition<
  BuiltinCommandContext,
  BuiltinCommandEffect
>;

function promptEffect(
  name: string,
  description: string,
  prompt: string,
  allowedTools: string[],
): BuiltinCommandEffect {
  return {
    type: 'send-prompt',
    prompt,
    context: {
      command: { name, description, body: prompt, source: 'project' },
      resolvedBody: prompt,
      allowedTools,
    },
  };
}

/**
 * Leading scope flags, exactly the set `book config` defines. `--user` is not
 * one of them: accepting a spelling the CLI rejects is the same divergence this
 * command exists to close, pointing the other way.
 */
const CONFIG_SCOPE_FLAGS: Record<string, SettingsScope> = {
  '--local': 'local',
  '--project': 'project',
  '--global': 'user',
  '-g': 'user',
};

/** The refusal `book config` prints for two scopes, word for word. */
const DUPLICATE_SCOPE_ERROR =
  'Pass at most one of --global, --project, --local. ' +
  'Writes default to --global; reads without one report the resolved merge.';

type ConfigScopeParse =
  | {
      ok: true;
      /** Undefined means the user named no layer, so the setting's own decides. */
      scope?: SettingsScope;
      rest: string;
    }
  | { ok: false; error: string };

function parseConfigScope(rawArguments: string): ConfigScopeParse {
  let rest = rawArguments.trim();
  let scope: SettingsScope | undefined;
  for (;;) {
    const flag = Object.keys(CONFIG_SCOPE_FLAGS).find(
      (candidate) => rest === candidate || rest.startsWith(`${candidate} `),
    );
    if (!flag) break;
    const next = CONFIG_SCOPE_FLAGS[flag];
    // Two scopes name two files, and silently keeping the last one would write
    // somewhere the user did not ask for. `book config` errors here too.
    if (scope && scope !== next) return { ok: false, error: DUPLICATE_SCOPE_ERROR };
    scope = next;
    rest = rest.slice(flag.length).trim();
  }
  return { ok: true, scope, rest };
}

/**
 * The settings a running session holds outside `settings`, or re-reads live from
 * it, with the layer their own writer targets.
 *
 * These eight are why a typed `/config <key>=<value>` used to be a trap. Writing
 * `model` into a file changes nothing about the session already running, so the
 * command reported success for a switch that had not happened — and it wrote a
 * different layer than the `/config` menu row for the same setting, so the two
 * halves of one command disagreed about where the preference lived. Handing them
 * to the effect the menu and the dedicated command already use makes
 * `/config model=x` exactly `/model x`: one setting, one file, one moment.
 *
 * The layer matters because naming a scope has to mean something. Asking for the
 * layer a setting already uses is not a different request, so it still takes the
 * live path; asking for a *different* file is, so it gets a literal write and a
 * reply saying the change waits for the next start.
 *
 * No key here may be one {@link guardSettingWrite} refuses. The guard runs
 * before this branch anyway, so the two cannot diverge silently.
 */
interface LiveSetting {
  layer: SettingsScope;
  effect: (value: unknown, context: BuiltinCommandContext) => BuiltinCommandEffect;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value);
}

/** Booleans stay booleans; `on`/`off` would be a second spelling of one setting. */
function booleanEffect(
  key: string,
  value: unknown,
  build: (enabled: boolean) => BuiltinCommandEffect,
): BuiltinCommandEffect {
  return typeof value === 'boolean'
    ? build(value)
    : {
        type: 'local-message',
        content: `✕ ${key} takes true or false, not ${JSON.stringify(value)}.`,
        isError: true,
      };
}

const LIVE_SETTINGS: Record<string, LiveSetting> = {
  model: {
    layer: 'user',
    effect: (value) => ({ type: 'set-model', selection: textOf(value) }),
  },
  compactModel: {
    layer: 'user',
    effect: (value) => ({ type: 'set-compact-model', model: textOf(value) }),
  },
  // The theme picker persists locally on purpose: a theme name can come from a
  // project's `.book/themes`, so a global value would not resolve elsewhere.
  theme: {
    layer: 'local',
    effect: (value) => ({ type: 'set-theme', preference: textOf(value) }),
  },
  effort: {
    layer: 'user',
    effect: (value, context) => {
      // The same refusal `/effort` gives, rather than persisting a level the
      // active model has no way to spend.
      if (context.effortUnavailableError) {
        return {
          type: 'local-message',
          content: `✕ ${context.effortUnavailableError}`,
          isError: true,
        };
      }
      const level = textOf(value).toLowerCase();
      return isEffortLevel(level)
        ? { type: 'set-effort', level }
        : { type: 'local-message', content: EFFORT_USAGE, isError: true };
    },
  },
  defaultMode: {
    layer: 'user',
    effect: (value) => {
      const mode = normalizePermissionMode(textOf(value));
      return mode
        ? { type: 'set-default-permission-mode', mode }
        : {
            type: 'local-message',
            content:
              `✕ Unknown permission mode "${textOf(value)}". Use one of: ` +
              'default, acceptEdits, plan, auto, dontAsk, bypassPermissions.',
            isError: true,
          };
    },
  },
  'ui.showThinking': {
    layer: 'user',
    effect: (value) =>
      booleanEffect('ui.showThinking', value, (enabled) => ({
        type: 'set-show-thinking',
        enabled,
      })),
  },
  'ui.startupAnimation': {
    layer: 'user',
    effect: (value) =>
      booleanEffect('ui.startupAnimation', value, (enabled) => ({
        type: 'set-startup-animation',
        enabled,
      })),
  },
  'memory.autoSave': {
    layer: 'user',
    effect: (value) =>
      booleanEffect('memory.autoSave', value, (enabled) => ({
        type: 'set-memory-auto-save',
        enabled,
      })),
  },
};

function configCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  if (!rawArguments) return { type: 'show-modal', modal: 'config' };

  const parsed = parseConfigScope(rawArguments);
  if (!parsed.ok) return { type: 'local-message', content: `✕ ${parsed.error}`, isError: true };
  const { scope, rest } = parsed;

  if (rest === '--help') {
    return {
      type: 'local-message',
      content:
        formatSettingsKeyHelp('Supported keys (experimental.* is user-global/--settings only):') +
        '\n\nUsage: /config <key>=<value>            writes the layer that setting uses\n' +
        '                                        (user-global for all but theme)\n' +
        '       /config --global <key>=<value>   force <BOOK_HOME>/settings.json\n' +
        '       /config --project <key>=<value>  force .book/settings.json\n' +
        '       /config --local <key>=<value>    force .book/settings.local.json\n' +
        '       /config compact-model <provider/model>',
    };
  }
  const compactModelMatch = rest.match(/^compact-model\s+(.+)$/i);
  if (compactModelMatch?.[1]?.trim()) {
    // A flag can follow the keyword as easily as precede it, and swallowing it
    // into the value set the compact model to the literal string `--local …`.
    const tail = parseConfigScope(compactModelMatch[1]);
    if (!tail.ok) return { type: 'local-message', content: `✕ ${tail.error}`, isError: true };
    if (scope && tail.scope && scope !== tail.scope) {
      return { type: 'local-message', content: `✕ ${DUPLICATE_SCOPE_ERROR}`, isError: true };
    }
    const resolved = scope ?? tail.scope;
    const prefix = resolved ? `${scopeFlagFor(resolved)} ` : '';
    return configCommandEffect(
      `${prefix}compactModel=${JSON.stringify(tail.rest.trim())}`,
      context,
    );
  }
  if (/^(?:compact-strategy|compactStrategy)(?:\s|=)/i.test(rest)) {
    return {
      type: 'local-message',
      content:
        'Compact strategy selection was removed. Summary is the default; enable the ' +
        'Zero-Mem experiment with BOOK_EXPERIMENTAL_ZERO_MEM=true or ' +
        'experimental.zeroMem=true in <BOOK_HOME>/settings.json (normally ' +
        '~/.book/settings.json), or pass an explicit --settings file.',
    };
  }
  if (!rest.includes('=')) {
    return { type: 'local-message', content: 'Usage: /config [key=value] or /config --help' };
  }

  const separator = rest.indexOf('=');
  const rawKey = rest.slice(0, separator).trim();
  const normalizedKey = rawKey.toLowerCase();
  const key = normalizedKey === 'compact-model' ? 'compactModel' : rawKey;
  const rawValue = rest.slice(separator + 1).trim();
  let value: unknown = rawValue;
  try {
    value = JSON.parse(rawValue);
  } catch {
    // Unquoted values are stored as strings.
  }

  // Ahead of the live branch as well as the write, so a refused key cannot be
  // reached through whichever of the two paths happens not to check it.
  const refusal = guardSettingWrite(key, value);
  if (refusal) return { type: 'local-message', content: `✕ ${refusal}`, isError: true };

  // Naming the layer a setting already uses is the same request as naming none;
  // naming a different one is a request to write that file literally.
  const live = LIVE_SETTINGS[key];
  if (live && (!scope || scope === live.layer)) return live.effect(value, context);

  const result = applySettingWrite({
    workspace: context.workspace,
    key,
    value,
    scope: scope ?? 'user',
    settingsOverridePath: context.runtimeConfig.settingsContext?.overridePath,
    noSettings: context.runtimeConfig.settingsContext?.noSettings,
  });
  if (!result.ok) {
    return { type: 'local-message', content: `✕ ${result.error}`, isError: true };
  }
  const shadows = result.shadowedBy.map((shadow) => `\n⚠  ${describeSettingShadow(shadow, key)}`);
  return {
    type: 'local-message',
    content:
      `Set ${key} = ${JSON.stringify(redactSettingValue(key, result.value))} in ` +
      `${settingsScopeLabel(result.scope)} settings (${result.path}). ` +
      'Takes effect on the next start.' +
      shadows.join(''),
  };
}

/** The flag that names a scope, for re-entering this parser with it intact. */
function scopeFlagFor(scope: SettingsScope): string {
  return scope === 'user' ? '--global' : `--${scope}`;
}

function resolveMemoryCandidate(workspace: string, raw: string): string | undefined {
  if (!raw) return undefined;
  const candidates = listMemoryCandidates(workspace);
  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= candidates.length) {
    return candidates[index - 1].name;
  }
  return raw;
}

function memoryCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  if (!rawArguments || rawArguments === 'status') {
    const loaded = context.runtimeConfig.settings.memory.enabled
      ? (context.runtimeConfig.memoryContext ?? loadMemoryContext(context.workspace))
      : undefined;
    return {
      type: 'local-message',
      content: buildMemoryReport({
        workspace: context.workspace,
        settings: context.runtimeConfig.settings,
        loaded,
      }),
    };
  }
  if (rawArguments === 'inbox') {
    return {
      type: 'local-message',
      content: buildMemoryInboxReport({ workspace: context.workspace }),
    };
  }
  if (rawArguments === 'path') {
    return { type: 'local-message', content: getProjectMemoryDir(context.workspace) };
  }
  if (rawArguments === 'on' || rawArguments === 'auto-save on') {
    return { type: 'set-memory-auto-save', enabled: true };
  }
  if (rawArguments === 'off' || rawArguments === 'auto-save off') {
    return { type: 'set-memory-auto-save', enabled: false };
  }
  if (rawArguments.startsWith('approve ') || rawArguments.startsWith('discard ')) {
    const approve = rawArguments.startsWith('approve ');
    const target = resolveMemoryCandidate(
      context.workspace,
      rawArguments.slice(approve ? 'approve '.length : 'discard '.length).trim(),
    );
    const result = target
      ? approve
        ? approveMemoryCandidate(context.workspace, target)
        : discardMemoryCandidate(context.workspace, target)
      : { ok: false as const, error: 'Missing candidate id or filename.' };
    return {
      type: 'local-message',
      content: result.ok
        ? `${approve ? 'Approved' : 'Discarded'} memory candidate → ${result.path}`
        : `✕ ${result.error}`,
      refreshMemory: result.ok && approve,
    };
  }
  return {
    type: 'local-message',
    content: 'Usage: /memory [status|inbox|approve <n|file>|discard <n|file>|on|off|path]',
  };
}

const AGENT_USAGE =
  'Usage: /agent <id> | /agent send <id> <message> | /agent stop <id> | /agent apply <id> [evidence-id]';

function agentCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  const [actionOrId, id, ...rest] = rawArguments.split(/\s+/).filter(Boolean);
  if (!actionOrId) return { type: 'local-message', content: AGENT_USAGE };
  if (actionOrId === 'send') {
    return id
      ? { type: 'managed-agent', operation: 'send', agentId: id, message: rest.join(' ') }
      : { type: 'local-message', content: AGENT_USAGE };
  }
  if (actionOrId === 'stop') {
    return id
      ? { type: 'managed-agent', operation: 'stop', agentId: id }
      : { type: 'local-message', content: AGENT_USAGE };
  }
  if (actionOrId === 'apply') {
    if (!id) return { type: 'local-message', content: AGENT_USAGE };
    if (context.mode === 'plan') {
      return { type: 'local-message', content: '✕ Agent apply is unavailable in plan mode.' };
    }
    return {
      type: 'managed-agent',
      operation: 'apply',
      agentId: id,
      evidenceId: rest[0],
    };
  }
  return { type: 'managed-agent', operation: 'get', agentId: actionOrId };
}

function usageCommandEffect(context: BuiltinCommandContext): BuiltinCommandEffect {
  const rate = PRICING[context.runtimeConfig.model];
  const estimatedCostUsd =
    context.usage && rate
      ? (context.usage.promptTokens * rate.in + context.usage.completionTokens * rate.out) /
        1_000_000
      : undefined;
  const toolCallStats =
    context.toolCallStats && context.toolCallStats.size > 0
      ? [...context.toolCallStats.entries()]
          .map(([tool, stats]) => ({
            tool,
            calls: stats.calls,
            failures: { ...stats.failures },
          }))
          // Failing tools first so a low-volume failing tool is never hidden
          // behind read-heavy tools in the capped TUI card.
          .sort((a, b) => failureTotal(b.failures) - failureTotal(a.failures) || b.calls - a.calls)
      : undefined;
  return {
    type: 'local-message',
    content: usageReport(
      context.runtimeConfig.model,
      context.usage,
      {
        currentTurn: context.currentTurn,
        messageCount: context.messages.length,
        turnDurationMs: context.turnDurationMs,
      },
      toolCallStats,
    ),
    display: {
      kind: 'usage',
      model: context.runtimeConfig.model,
      currentTurn: context.currentTurn,
      messageCount: context.messages.length,
      turnDurationMs: context.turnDurationMs,
      usage: context.usage,
      rate: rate ? { inputPerMillion: rate.in, outputPerMillion: rate.out } : undefined,
      estimatedCostUsd,
      toolCallStats,
    },
  };
}

function contextCommandEffect(context: BuiltinCommandContext): BuiltinCommandEffect {
  const dynamic = context.resolveAmbientContext();
  const ambient = {
    model: context.runtimeConfig.model,
    // The window compaction actually acts on. Falling back to runtimeConfig.maxTokens
    // reported max *output* tokens as the context window (64k vs the real 272k default).
    maxTokens: resolveContextLimit(context.runtimeConfig),
    windowDeclared: hasDeclaredContextWindow(context.runtimeConfig),
    contextHistory: context.contextHistory,
    compactBoundaries: context.compactBoundaries,
    skillCount: context.skillCount,
    commandCount: context.commandCount,
    ...dynamic,
  };
  const breakdown = buildContextBreakdown(context.contextHistory);
  return {
    type: 'local-message',
    content: buildContextReport(context.messages, ambient),
    display: {
      kind: 'context',
      model: ambient.model,
      maxTokens: ambient.maxTokens,
      windowDeclared: hasDeclaredContextWindow(context.runtimeConfig),
      estimatedTokens: breakdown.estimatedTokens,
      totalMessages: breakdown.totalMessages,
      userMessages: breakdown.userMessages,
      assistantMessages: breakdown.assistantMessages,
      toolCalls: breakdown.toolCalls,
      toolResults: breakdown.toolResults,
      userTokens: breakdown.byRole.user,
      assistantTokens: breakdown.byRole.assistant,
      ambient: {
        commandCount: ambient.commandCount,
        skillCount: ambient.skillCount,
        subagentCount: ambient.subagentCount,
        hasMemoryIndex: ambient.hasMemoryIndex,
        hasClaudeMdLoader: ambient.hasClaudeMdLoader,
      },
    },
  };
}

export const BUILTIN_COMMAND_DEFINITIONS: BuiltinCommandDefinition[] = [
  {
    name: 'clear',
    description: 'Start a new conversation',
    argumentHint: '[previous-name]',
    aliases: [
      { name: 'new', description: 'Start a new conversation', argumentHint: '[previous-name]' },
      {
        name: 'reset',
        description: 'Alias for /clear',
        argumentHint: '[previous-name]',
        isHidden: true,
      },
    ],
    execute: ({ rawArguments }) => ({
      type: 'start-new-conversation',
      previousName: rawArguments || undefined,
    }),
  },
  {
    name: 'resume',
    description: 'Resume a saved conversation',
    argumentHint: '[id|name]',
    aliases: [
      {
        name: 'continue',
        description: 'Alias for /resume',
        argumentHint: '[id|name]',
        isHidden: true,
      },
    ],
    execute: ({ rawArguments }) => ({
      type: 'resume-conversation',
      session: rawArguments || undefined,
    }),
  },
  {
    name: 'compact',
    description: 'Summarize older turns',
    argumentHint: '[focus instructions]',
    execute: ({ rawArguments }) => ({ type: 'compact', focus: rawArguments || undefined }),
  },
  {
    name: 'rewind',
    description: 'Restore conversation, workspace code, or both',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'local-message', content: 'Usage: /rewind' }
        : { type: 'show-modal', modal: 'rewind' },
  },
  {
    name: 'exit',
    description: 'Exit book',
    execute: () => ({ type: 'exit' }),
  },
  {
    name: 'help',
    description: 'Toggle help',
    execute: () => ({ type: 'toggle-panel', panel: 'help' }),
  },
  {
    name: 'task',
    description: 'Add a task',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'add-task', subject: rawArguments }
        : { type: 'local-message', content: 'Usage: /task <subject>' },
  },
  {
    name: 'agents',
    description: 'Configure subagents or import agent definitions',
    argumentHint: '[import [--confirm] <path>]',
    execute: ({ rawArguments }) => {
      const parts = rawArguments.split(/\s+/).filter(Boolean);
      if (parts[0] !== 'import') {
        return {
          type: 'local-message',
          content:
            'Subagents run from the prompt-adjacent job panel. Use /jobs (or /tasks) to inspect them; configure definitions in .book/agents or ~/.book/agents.',
        };
      }
      const confirmed = parts[1] === '--confirm';
      const importPath = parts.slice(confirmed ? 2 : 1).join(' ');
      return importPath
        ? { type: 'managed-agent', operation: 'import', importPath, confirmed }
        : { type: 'local-message', content: 'Usage: /agents import [--confirm] <path>' };
    },
  },
  {
    name: 'jobs',
    description: 'View and manage background agents and shell jobs in this session',
    execute: () => ({ type: 'managed-agent', operation: 'list' }),
  },
  {
    name: 'tasks',
    description: 'Alias for /jobs',
    execute: () => ({ type: 'managed-agent', operation: 'list' }),
  },
  {
    name: 'agent',
    description: 'Inspect or control a managed agent',
    argumentHint: '<id>|send <id> <message>|stop <id>|apply <id>',
    execute: ({ rawArguments }, context) => agentCommandEffect(rawArguments, context),
  },
  {
    name: 'theme',
    description: 'Switch color theme',
    argumentHint: '[dark|light|auto|name]',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'set-theme', preference: rawArguments }
        : { type: 'show-modal', modal: 'theme' },
  },
  {
    name: 'model',
    description: 'Switch models and manage BYOK providers',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'set-model', selection: rawArguments }
        : { type: 'show-modal', modal: 'model' },
  },
  {
    name: 'providers',
    description: 'Add or remove workspace BYOK providers',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'local-message', content: 'Usage: /providers' }
        : { type: 'show-modal', modal: 'model' },
  },
  {
    name: 'login',
    description: 'Sign in with a provider subscription (OAuth)',
    argumentHint: '[profile]',
    execute: ({ rawArguments }, context) => {
      const requested = rawArguments.trim();
      // An unrecognised id must not fall through to "first profile in the
      // list": Enter would then start an OAuth flow for a different vendor
      // than the one the user typed. `book auth login <bogus>` refuses too.
      if (requested && !resolveAuthProfile(requested, context.runtimeConfig.settings)) {
        const known = listAuthProfiles(context.runtimeConfig.settings)
          .map((profile) => profile.id)
          .join(', ');
        return {
          type: 'local-message',
          content: `✕ Unknown auth profile "${requested}". Available: ${known || '(none)'}`,
        };
      }
      return { type: 'show-modal', modal: 'login', profile: requested || undefined };
    },
  },
  {
    name: 'effort',
    description: 'Set thinking effort',
    argumentHint: '[low|medium|high|xhigh|max]',
    execute: ({ rawArguments }, context) => {
      if (!rawArguments) {
        return context.effortUnavailableError
          ? { type: 'local-message', content: `✕ ${context.effortUnavailableError}` }
          : { type: 'show-modal', modal: 'effort' };
      }
      const normalized = rawArguments.toLowerCase();
      return isEffortLevel(normalized)
        ? { type: 'set-effort', level: normalized }
        : { type: 'local-message', content: EFFORT_USAGE };
    },
  },
  {
    name: 'config',
    description: 'Show current configuration',
    execute: ({ rawArguments }, context) => configCommandEffect(rawArguments, context),
  },
  {
    name: 'diff',
    description: 'Show git diff',
    execute: () => ({ type: 'show-diff' }),
  },
  {
    name: 'status',
    description: 'Show session status',
    execute: () => ({ type: 'toggle-panel', panel: 'status' }),
  },
  {
    name: 'memory',
    description: 'Manage auto-memory',
    argumentHint: '[status|inbox|approve|discard|on|off|path]',
    execute: ({ rawArguments }, context) => memoryCommandEffect(rawArguments, context),
  },
  {
    name: 'permissions',
    description: 'Manage permission rules',
    execute: () => ({ type: 'toggle-panel', panel: 'permissions' }),
  },
  {
    name: 'mcp',
    description: 'Show MCP server status, trust, transports, and tool counts',
    argumentHint: '[status]',
    execute: ({ rawArguments }, context) =>
      !rawArguments || rawArguments === 'status'
        ? { type: 'local-message', content: buildMcpStatusReport(context.mcpSnapshot) }
        : { type: 'local-message', content: 'Usage: /mcp [status]' },
  },
  {
    name: 'cost',
    description: 'Show token usage and cost',
    execute: (_invocation, context) => ({
      type: 'local-message',
      content: costReport(context.runtimeConfig.model, context.usage),
    }),
  },
  {
    name: 'skills',
    description: 'Manage available skills',
    argumentHint: '[status]',
    execute: ({ rawArguments }, context) =>
      rawArguments === 'status'
        ? { type: 'local-message', content: buildSkillReport(context.skillSnapshot) }
        : rawArguments
          ? { type: 'local-message', content: 'Usage: /skills [status]' }
          : { type: 'show-modal', modal: 'skills' },
  },
  {
    name: 'init',
    description: 'Initialize project with CLAUDE.md',
    // Pure prompt body from the workspace path: runnable in print/headless.
    nonInteractive: true,
    execute: (_invocation, context) => {
      const prompt = buildInitPrompt(context.workspace);
      return promptEffect('init', 'Initialize CLAUDE.md', prompt, [
        'Read',
        'Glob',
        'Grep',
        'Write',
      ]);
    },
  },
  {
    name: 'reload-skills',
    description: 'Reload commands and skills',
    execute: () => ({ type: 'reload-assets' }),
  },
  {
    name: 'export',
    description: 'Export conversation to file',
    execute: ({ rawArguments }, context) => {
      const filename = rawArguments || 'conversation.txt';
      try {
        const text = context.messages
          .map((message) => `${message.role}:\n${message.content}`)
          .join('\n\n---\n\n');
        const destination = join(context.workspace, filename);
        writeFileSync(destination, text, 'utf-8');
        return {
          type: 'local-message',
          content: `Exported ${context.messages.length} messages to ${destination}`,
        };
      } catch (error) {
        return {
          type: 'local-message',
          content: `✕ export failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  },
  {
    name: 'usage',
    description: 'Session cost & token usage (alias: /stats)',
    aliases: [{ name: 'stats', description: 'Alias for /usage', isHidden: true }],
    execute: (_invocation, context) => usageCommandEffect(context),
  },
  {
    name: 'context',
    description: 'Show what is filling the context window',
    execute: (_invocation, context) => contextCommandEffect(context),
  },
  {
    name: 'review',
    description: 'Review current git diff (correctness & cleanups)',
    // Host-orchestrated: the effect carries only the parsed scope, and the host
    // resolves the review target itself. Nothing here needs a live conversation,
    // so print/headless can perform it (see `commands/print-dispatch.ts`).
    nonInteractive: true,
    execute: ({ rawArguments }) => {
      const scope = parseReviewScope(rawArguments);
      if (scope.help) return { type: 'local-message', content: REVIEW_USAGE };
      if (scope.error) {
        return {
          type: 'local-message',
          content: `✕ ${scope.error}\n\n${REVIEW_USAGE}`,
          isError: true,
        };
      }
      return { type: 'review', scope };
    },
  },
  {
    name: 'security-review',
    description: 'Security audit of current git diff',
    // Pure prompt body from arguments + REVIEW.md: runnable in print/headless.
    nonInteractive: true,
    execute: ({ rawArguments }, context) => {
      const prompt = buildSecurityReviewPrompt(rawArguments, context.workspace);
      return promptEffect('security-review', 'Security audit of current diff', prompt, [
        ...SECURITY_REVIEW_TOOLS,
      ]);
    },
  },
  {
    name: 'release-notes',
    description: 'Show installed version + changelog',
    execute: (_invocation, context) => ({
      type: 'local-message',
      content: buildReleaseNotesReport(context.workspace),
    }),
  },
  {
    name: 'feedback',
    description: 'Save a bug-report snapshot to .book/feedback/',
    execute: ({ rawArguments }, context) => {
      const lastUser = [...context.messages].reverse().find((message) => message.role === 'user');
      const result = writeFeedbackReport({
        workspace: context.workspace,
        model: context.model,
        provider: context.provider,
        turn: context.currentTurn,
        messageCount: context.messages.length,
        lastUserPromptPreview: lastUser?.content,
        lastError: context.lastError,
        note: rawArguments || undefined,
      });
      return {
        type: 'local-message',
        content: result.ok
          ? `Saved feedback report to ${result.path}. Review it before sharing.`
          : `✕ feedback failed: ${result.error}`,
      };
    },
  },
];

function metadataForAlias(
  definition: BuiltinCommandDefinition,
  alias: CommandAlias,
): BuiltinCommand {
  return {
    name: alias.name,
    description: alias.description ?? `Alias for /${definition.name}`,
    argumentHint: alias.argumentHint ?? definition.argumentHint,
    isHidden: alias.isHidden,
  };
}

/** Shared metadata consumed by autocomplete, help, and system-prompt generation. */
export const BUILTIN_COMMANDS: BuiltinCommand[] = BUILTIN_COMMAND_DEFINITIONS.flatMap(
  (definition) => [
    {
      name: definition.name,
      description: definition.description,
      argumentHint: definition.argumentHint,
      isHidden: definition.isHidden,
    },
    ...(definition.aliases ?? []).map((alias) => metadataForAlias(definition, alias)),
  ],
);

export const BUILTIN_BY_NAME: Record<string, BuiltinCommand> = Object.fromEntries(
  BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

export function createBuiltinCommandRegistry(): CommandRegistry<
  BuiltinCommandContext,
  BuiltinCommandEffect
> {
  const registry = new CommandRegistry<BuiltinCommandContext, BuiltinCommandEffect>();
  registry.registerAll(BUILTIN_COMMAND_DEFINITIONS);
  return registry;
}
