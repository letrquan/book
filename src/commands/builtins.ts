import { resolve } from 'path';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { CommandContext } from '../types/commands.js';
import type { LocalCommandDisplay, Message, Usage } from '../types/messages.js';
import type { CompactBoundary } from '../types/sessions.js';
import type { ActiveGoal } from '../types/goal.js';
import { formatGoalReport, GOAL_MAX_CHARS, isGoalClearWord } from '../agent/goal.js';
import { buildInitPrompt } from './init-prompt.js';
import {
  buildMemoryConsolidatePrompt,
  buildSecurityReviewPrompt,
  memoryConsolidateTools,
  SECURITY_REVIEW_TOOLS,
} from './builtins-prompts.js';
import { parseReviewScope, REVIEW_USAGE } from '../review/scope.js';
import type { ReviewScope } from '../review/types.js';
import { CommandRegistry, type CommandAlias, type CommandDefinition } from './registry.js';
import { buildReleaseNotesReport, writeFeedbackReport } from '../version-info.js';
import { EFFORT_USAGE, isEffortLevel, type EffortLevel } from './effort.js';
import { redactSettingValue } from '../settings-redaction.js';
import { formatSettingsKeyHelp, writeFileAtomic } from '../settings-repository.js';
import { projectFileWriteRefusal } from '../workspace-files.js';
import { resolveWorkspacePath } from '../tools/path-utils.js';
import { reachesUncPath } from '../unc-path.js';
import { buildMemoryReport } from '../memory-display.js';
import {
  deleteMemoryEntry,
  getProjectMemoryDir,
  listMemoryFiles,
  memoryWriteScope,
} from '../memory-store.js';
import { denyRulesRefuseMemoryWrites } from '../memory-access.js';
import { promptCurrentDate } from '../agent/prompt-determinism.js';
import {
  costReport,
  failureTotal,
  resolveModelPricing,
  sessionTotals,
  usageCostForModel,
  usageReport,
  type BillScope,
  type DelegatedUsage,
} from '../pricing.js';
import { buildContextBreakdown, buildContextReport, sourceLabel } from '../context-report.js';
import { resolveContextWindow } from '../models.js';
import type { SkillRegistrySnapshot } from '../skill-registry.js';
import { buildSkillReport } from '../skill-report.js';
import { buildMcpStatusReport } from '../mcp-report.js';
import type { McpHostSnapshot } from '../mcp-host.js';
import { settingsScopeLabel, type SettingsScope } from '../settings-scope.js';
import { applySettingWrite, describeSettingShadow, guardSettingWrite } from '../settings-write.js';
import { normalizePermissionMode } from '../permission-mode.js';
import {
  advisorModelRefusal,
  configuredAdvisorModel,
  describeUnresolvedProviderPrefix,
} from '../config.js';

export interface BuiltinCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Hide from / autocomplete when empty, but still match when typed exactly. */
  isHidden?: boolean;
  /** Listed for the TUI's menu and help only; see `CommandDefinition.tuiOnly`. */
  tuiOnly?: boolean;
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
  /** The session's `/goal`, for `/goal` with no argument. */
  activeGoal?: ActiveGoal;
  /**
   * Every response this session has spent, cumulatively.
   *
   * `usage` is the per-request figure the context meter reads, so it is replaced
   * on every model response and cleared on every send and compaction. A bill is
   * not that: /cost and /usage price this instead, falling back to `usage` for a
   * host that only has the per-request value (#370).
   */
  sessionUsage?: Usage | null;
  /**
   * Running USD cost for the lead session, priced per request with basis 'request',
   * or null if any request could not be priced.
   */
  sessionCostUsd?: number | null;
  /**
   * Set when the cumulative bill starts at a resume in this process rather than at
   * the session's first turn, so both reports can say what the figure covers
   * (#370).
   */
  sessionUsageSinceResume?: boolean;
  turnDurationMs: number;
  contextHistory: Message[];
  compactBoundaries: CompactBoundary[];
  commandCount: number;
  skillCount: number;
  skillSnapshot?: SkillRegistrySnapshot;
  mcpSnapshot?: McpHostSnapshot;
  /** Per-session tool call/failure counters keyed by canonical tool name. */
  toolCallStats?: ReadonlyMap<string, { calls: number; failures: Record<string, number> }>;
  /**
   * Usage from delegated agents, attributed to the model each actually ran on.
   *
   * Kept separate from `usage`, which counts only this session's own turns: a
   * child's tokens reach its agent record and never the parent's counter, so
   * these are additive rather than a subset.
   */
  delegatedUsage?: readonly DelegatedUsage[];
  resolveAmbientContext: () => {
    subagentCount: number;
    hasMemoryIndex: boolean;
    hasClaudeMdLoader: boolean;
  };
}

export type BuiltinCommandEffect =
  | {
      type: 'send-prompt';
      prompt: string;
      context: CommandContext;
      /**
       * The prompt carries the repository's own text (`REVIEW.md`), so the host expands it as it
       * does a project command's body: its mentions inline only files git has committed,
       * unchanged, and none of its `!` lines run (#564).
       */
      projectCommand?: boolean;
    }
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
  /** `/goal <condition>`: set the session goal and start a turn toward it. */
  | { type: 'set-goal'; condition: string }
  /** `/goal clear` (or stop, off, reset, none, cancel). */
  | { type: 'clear-goal' }
  | { type: 'exit' }
  | {
      type: 'show-modal';
      modal: 'config' | 'model' | 'advisor' | 'rewind' | 'effort' | 'skills' | 'agents';
    }
  | { type: 'set-model'; selection: string }
  | { type: 'set-effort'; level: EffortLevel }
  | { type: 'set-compact-model'; model: string }
  /** `/advisor <model>` sets the advisor model; `null` turns the advisor off. */
  | { type: 'set-advisor'; model: string | null; notice?: string }
  | { type: 'set-default-permission-mode'; mode: PermissionMode }
  | { type: 'set-show-thinking'; enabled: boolean }
  | { type: 'set-startup-animation'; enabled: boolean }
  | { type: 'set-memory-auto-save'; enabled: boolean }
  | { type: 'toggle-panel'; panel: 'help' | 'status' | 'permissions' | 'tasks' }
  | { type: 'add-task'; subject: string }
  | { type: 'show-diff' }
  | { type: 'reload-assets' }
  /** Sign in with ChatGPT (experimental); only the interactive host can open a browser. */
  | { type: 'chatgpt-auth'; action: 'login' | 'logout'; newAccount?: boolean }
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

/**
 * A built-in command's prompt. `repositoryText` says whether the prompt carries text the
 * repository wrote (REVIEW.md), which the host then expands as a project command's body.
 */
function promptEffect(
  name: string,
  description: string,
  prompt: string,
  allowedTools: string[],
  repositoryText: boolean,
): BuiltinCommandEffect {
  return {
    type: 'send-prompt',
    prompt,
    context: {
      command: { name, description, body: prompt, source: 'project' },
      resolvedBody: prompt,
      allowedTools,
    },
    ...(repositoryText ? { projectCommand: true } : {}),
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
        formatSettingsKeyHelp('Supported keys:') +
        '\n\nUsage: /config <key>=<value>            writes the layer that setting uses\n' +
        '                                        (user-global by default)\n' +
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
  // reached through whichever of the two paths happens not to check it. The
  // parsed value and the layer it is aimed at both go in: without the value the
  // guard judged the path alone and refused `sandbox={"enabled":true}` for the
  // one value a workspace layer may set, and without the scope it applied a
  // workspace filter to a write aimed at the user-global layer, which is the
  // default here.
  const refusal = guardSettingWrite(key, value, scope ?? 'user');
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

const MEMORY_USAGE = 'Usage: /memory [status|delete <file>|on|off|path|consolidate [focus]]';

function memoryRefusal(content: string): BuiltinCommandEffect {
  // `isError` so a print host fails the run instead of exiting 0 on a pass that never happened.
  return { type: 'local-message', content: `✕ ${content}`, isError: true };
}

/**
 * `/memory consolidate [focus]`: one agent pass over the memory directory, run as an ordinary
 * prompt so the user watches its edits as tool rows. Refused, with no prompt sent, when the pass
 * could not write what it finds.
 */
function memoryConsolidateEffect(
  focus: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  const config = context.runtimeConfig;
  if (!config.settings.memory.enabled) {
    return memoryRefusal(
      'Memory is disabled (memory.enabled is false), so there is nothing to consolidate.',
    );
  }
  if (context.mode === 'plan') {
    return memoryRefusal('Plan mode is on, and consolidating edits memory. Leave plan mode first.');
  }
  const dir = getProjectMemoryDir(context.workspace);
  // The same two conditions `memorySection` writes the prompt's "you may write memory" on.
  if (memoryWriteScope(config) === 'none') {
    return memoryRefusal(
      'Memory is not writable in this session (memory.autoSave is off). Turn it on with /memory on.',
    );
  }
  if (denyRulesRefuseMemoryWrites(config, dir)) {
    return memoryRefusal(
      'A permission deny rule refuses writes to the memory directory, so a consolidation could not save anything.',
    );
  }
  if (listMemoryFiles(context.workspace).length === 0) {
    return memoryRefusal(`There are no memory files in \`${dir}\` to consolidate.`);
  }
  const prompt = buildMemoryConsolidatePrompt({
    memoryDir: dir,
    today: promptCurrentDate(),
    focus,
  });
  return promptEffect(
    'memory-consolidate',
    'Consolidate project memory',
    prompt,
    memoryConsolidateTools(dir),
    false,
  );
}

function memoryCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  if (!rawArguments || rawArguments === 'status') {
    // Read from disk rather than the session-start snapshot: a memory saved
    // mid-session must show up here, not at the next start.
    return {
      type: 'local-message',
      content: buildMemoryReport({
        workspace: context.workspace,
        settings: context.runtimeConfig.settings,
        sessionDriver: context.runtimeConfig.sessionDriver,
      }),
    };
  }
  if (rawArguments === 'path') {
    return { type: 'local-message', content: `\`${getProjectMemoryDir(context.workspace)}\`` };
  }
  if (rawArguments === 'on' || rawArguments === 'auto-save on') {
    return { type: 'set-memory-auto-save', enabled: true };
  }
  if (rawArguments === 'off' || rawArguments === 'auto-save off') {
    return { type: 'set-memory-auto-save', enabled: false };
  }
  if (rawArguments === 'delete' || rawArguments.startsWith('delete ')) {
    // A file name only: a model write can change the store mid-session, and deleting the
    // wrong file is not a mistake the user can see coming. The file's MEMORY.md line goes too.
    const target = rawArguments.slice('delete'.length).trim();
    const result = target
      ? deleteMemoryEntry(context.workspace, target)
      : { ok: false as const, error: 'Usage: /memory delete <file>' };
    return {
      type: 'local-message',
      content: result.ok ? `Deleted memory → \`${result.path}\`` : `✕ ${result.error}`,
      refreshMemory: result.ok,
    };
  }
  if (rawArguments === 'consolidate' || rawArguments.startsWith('consolidate ')) {
    return memoryConsolidateEffect(rawArguments.slice('consolidate'.length).trim(), context);
  }
  return { type: 'local-message', content: MEMORY_USAGE };
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

/**
 * The usage a session bill is priced from: the cumulative total where the host
 * keeps one, the last response otherwise (#370).
 */
function billableUsage(context: BuiltinCommandContext): Usage | null {
  return context.sessionUsage ?? context.usage;
}

/**
 * Running lead cost, defined only when cumulative session usage is kept. A host
 * that only reports the last turn's usage must not bill the lead at $0 (#415).
 */
function billableLeadCost(context: BuiltinCommandContext): number | null | undefined {
  return context.sessionUsage ? context.sessionCostUsd : undefined;
}

/** Where this bill starts counting, so a report can say when it is not the session's start. */
function billScope(context: BuiltinCommandContext): BillScope {
  return { sinceResume: context.sessionUsageSinceResume === true };
}

function usageCommandEffect(context: BuiltinCommandContext): BuiltinCommandEffect {
  const usage = billableUsage(context);
  const delegated = context.delegatedUsage ?? [];
  // The sheet is read as the session's spend, so it carries the same total the
  // text beside it does: the lead plus every delegated agent (#370).
  const totals = sessionTotals(
    context.runtimeConfig.model,
    usage,
    delegated,
    billableLeadCost(context),
  );
  // The same rate resolution as /cost and the /usage text, so a dated or aliased model id
  // prices here too.
  const priced = usage ? usageCostForModel(context.runtimeConfig.model, usage, 'pool') : undefined;
  const rate = priced?.rate ?? resolveModelPricing(context.runtimeConfig.model)?.rate;
  const estimatedCostUsd = totals.usd ?? undefined;
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
      usage,
      {
        currentTurn: context.currentTurn,
        messageCount: context.messages.length,
        turnDurationMs: context.turnDurationMs,
      },
      toolCallStats,
      delegated,
      billScope(context),
      billableLeadCost(context),
    ),
    display: {
      kind: 'usage',
      model: context.runtimeConfig.model,
      currentTurn: context.currentTurn,
      messageCount: context.messages.length,
      turnDurationMs: context.turnDurationMs,
      usage: usage ? totals.usage : null,
      rate: rate
        ? {
            inputPerMillion: rate.in,
            outputPerMillion: rate.out,
            longPrompt: rate.longPrompt
              ? {
                  overPromptTokens: rate.longPrompt.overPromptTokens,
                  inputPerMillion: rate.longPrompt.rate.in,
                  outputPerMillion: rate.longPrompt.rate.out,
                }
              : undefined,
          }
        : undefined,
      estimatedCostUsd,
      delegatedAgents: totals.delegatedAgents || undefined,
      toolCallStats,
    },
  };
}

function contextCommandEffect(context: BuiltinCommandContext): BuiltinCommandEffect {
  const dynamic = context.resolveAmbientContext();
  const contextWindow = resolveContextWindow(context.runtimeConfig);
  const source = sourceLabel(contextWindow.source);
  const ambient = {
    model: context.runtimeConfig.model,
    // The window compaction actually acts on. Falling back to runtimeConfig.maxTokens
    // reported max *output* tokens as the context window (64k vs the real 272k default).
    maxTokens: contextWindow.window,
    windowSource: source,
    windowDeclared: source === 'declared',
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
      windowSource: source,
      windowDeclared: source === 'declared',
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

/**
 * `/goal`: no argument reports the goal, a clear word clears it, anything else
 * sets it. The condition is the agent's directive and the evaluator's question
 * (`agent/goal.ts`), so it is kept exactly as typed.
 */
function goalCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  const condition = rawArguments.trim();
  if (!condition) return { type: 'local-message', content: formatGoalReport(context.activeGoal) };
  if (isGoalClearWord(condition)) return { type: 'clear-goal' };
  if (condition.length > GOAL_MAX_CHARS) {
    return {
      type: 'local-message',
      content: `Goal condition is limited to ${GOAL_MAX_CHARS} characters (got ${condition.length})`,
      isError: true,
    };
  }
  return { type: 'set-goal', condition };
}

/** Arguments that ask `/advisor` what it is set to (Claude Code's list), rather than set it. */
const ADVISOR_STATUS_WORDS: ReadonlySet<string> = new Set([
  'help',
  '-h',
  '--help',
  'list',
  'show',
  'display',
  'current',
  'view',
  'get',
  'check',
  'describe',
  'print',
  'version',
  'about',
  'status',
  '?',
]);
const ADVISOR_OFF_WORDS: ReadonlySet<string> = new Set(['off', 'unset', 'none', 'disable']);
const ADVISOR_USAGE = 'Usage: /advisor <model> | off';

/**
 * `/advisor`: pick, report, turn off, or name the model the `Advisor` tool consults.
 *
 * Bare, it opens the model picker. A model id typed from memory is how a saved
 * advisor came to be `claude`, which names no model, so the picker is the way in
 * and the status words are the way to just read what is set.
 */
function advisorCommandEffect(
  rawArguments: string,
  context: BuiltinCommandContext,
): BuiltinCommandEffect {
  const argument = rawArguments.trim();
  const word = argument.toLowerCase();
  if (!argument) return { type: 'show-modal', modal: 'advisor' };
  if (ADVISOR_STATUS_WORDS.has(word)) {
    const current = configuredAdvisorModel(context.runtimeConfig);
    // A stored id every consult would refuse is not working; say so rather than list it as set.
    const refusal = current ? advisorModelRefusal(context.runtimeConfig, current) : undefined;
    const shown = current ? `${current}${refusal ? ` (refused: ${refusal})` : ''}` : 'off';
    return { type: 'local-message', content: `Advisor: ${shown}\n${ADVISOR_USAGE}` };
  }
  if (ADVISOR_OFF_WORDS.has(word)) return { type: 'set-advisor', model: null };
  if (/\s/.test(argument)) {
    return { type: 'local-message', content: ADVISOR_USAGE, isError: true };
  }
  // Nothing is saved for an id whose key and endpoint are ambiguous (#419).
  const refusal = advisorModelRefusal(context.runtimeConfig, argument);
  if (refusal) return { type: 'local-message', content: refusal, isError: true };
  // A prefix that matches no configured provider is probably a typo; the id is saved all the
  // same, as on the main-model path, since it may be one vendor-namespaced model id.
  const notice = describeUnresolvedProviderPrefix(
    context.runtimeConfig.settings.provider,
    argument,
  );
  return notice
    ? { type: 'set-advisor', model: argument, notice }
    : { type: 'set-advisor', model: argument };
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
    name: 'advisor',
    description: 'Let Book consult a stronger model at key moments',
    argumentHint: '[<model> | off]',
    execute: ({ rawArguments }, context) => advisorCommandEffect(rawArguments, context),
  },
  {
    name: 'goal',
    description: 'Set a goal Book checks before stopping',
    argumentHint: '[<condition> | clear]',
    nonInteractive: true,
    execute: ({ rawArguments }, context) => goalCommandEffect(rawArguments, context),
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
    description: 'Add a task, or show your task list',
    argumentHint: '[subject]',
    execute: ({ rawArguments }) =>
      rawArguments
        ? { type: 'add-task', subject: rawArguments }
        : { type: 'toggle-panel', panel: 'tasks' },
  },
  {
    name: 'agents',
    description: 'Configure subagents or import agent definitions',
    argumentHint: '[import [--confirm] <path>]',
    execute: ({ rawArguments }) => {
      const parts = rawArguments.split(/\s+/).filter(Boolean);
      // Bare, it opens the subagent profiles, which is what "configure" means;
      // it used to print a sentence pointing somewhere else.
      if (parts.length === 0) return { type: 'show-modal', modal: 'agents' };
      if (parts[0] !== 'import') {
        return { type: 'local-message', content: 'Usage: /agents [import [--confirm] <path>]' };
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
    name: 'queue',
    description: 'Show the follow-up queue; /queue clear drops it',
    argumentHint: '[clear]',
    // The TUI handles /queue itself before this registry is consulted: the queue is its state.
    tuiOnly: true,
    execute: () => ({
      type: 'local-message',
      content: 'The follow-up queue belongs to the interactive session.',
    }),
  },
  {
    name: 'agent',
    description: 'Inspect or control a managed agent',
    argumentHint: '<id>|send <id> <message>|stop <id>|apply <id>',
    execute: ({ rawArguments }, context) => agentCommandEffect(rawArguments, context),
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
    argumentHint: '[status|delete|on|off|path|consolidate]',
    // Only `consolidate` produces a prompt; every other form changes host state or settings.
    nonInteractiveSubcommands: ['consolidate'],
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
      content: costReport(
        context.runtimeConfig.model,
        billableUsage(context),
        context.delegatedUsage ?? [],
        billScope(context),
        billableLeadCost(context),
      ),
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
      return promptEffect(
        'init',
        'Initialize CLAUDE.md',
        prompt,
        ['Read', 'Glob', 'Grep', 'Write'],
        false,
      );
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
        // Inside the workspace, as the file tools hold a write, and only ever a regular file:
        // written to a temporary file and renamed into place, never through what is there.
        // Asked before resolving: resolving follows links, and one to a network share would
        // already reach it.
        if (reachesUncPath(resolve(context.workspace, filename))) {
          return {
            type: 'local-message',
            content: `✕ export failed: ${filename} is a network path.`,
          };
        }
        const resolved = resolveWorkspacePath(context.workspace, filename);
        if (!resolved) {
          return {
            type: 'local-message',
            content: `✕ export failed: ${filename} is outside the workspace.`,
          };
        }
        const destination = resolved.filePath;
        const refusal = projectFileWriteRefusal(destination);
        if (refusal) {
          return {
            type: 'local-message',
            content: `✕ export failed: ${destination}: ${refusal}.`,
          };
        }
        const text = context.messages
          .map((message) => `${message.role}:\n${message.content}`)
          .join('\n\n---\n\n');
        writeFileAtomic(destination, text);
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
      // REVIEW.md is the repository's text, so the whole prompt, arguments included, is expanded
      // as a project command's body is, whether or not the workspace has one.
      return promptEffect(
        'security-review',
        'Security audit of current diff',
        prompt,
        [...SECURITY_REVIEW_TOOLS],
        true,
      );
    },
  },
  {
    name: 'login',
    description: 'Sign in with ChatGPT (experimental): use your ChatGPT plan',
    argumentHint: '[--new-account]',
    execute: ({ rawArguments }) => {
      const argument = rawArguments.trim();
      if (argument && argument !== '--new-account') {
        return { type: 'local-message', content: 'Usage: /login [--new-account]', isError: true };
      }
      return { type: 'chatgpt-auth', action: 'login', newAccount: argument === '--new-account' };
    },
  },
  {
    name: 'logout',
    description: 'Sign out of ChatGPT (experimental) and revoke the sign-in',
    execute: ({ rawArguments }) =>
      rawArguments.trim()
        ? { type: 'local-message', content: 'Usage: /logout', isError: true }
        : { type: 'chatgpt-auth', action: 'logout' },
  },
  {
    name: 'release-notes',
    description: 'Show installed version + changelog',
    execute: () => ({
      type: 'local-message',
      content: buildReleaseNotesReport(),
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
      tuiOnly: definition.tuiOnly,
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
