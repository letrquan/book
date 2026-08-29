import { z } from 'zod';
import { WORKFLOW_ID_MESSAGE, WORKFLOW_ID_PATTERN } from './harness/contracts.js';
import type { HarnessMode } from './harness/contracts.js';

/**
 * Permission rule: "Tool" or "Tool(specifier)" where specifier is a glob pattern
 * matched against the tool's primary argument (e.g. bash command, file path).
 */
export const permissionRuleSchema = z.string().min(1);

/**
 * Bash sandbox configuration (matches CC's sandbox.* keys).
 */
export const sandboxSchema = z.object({
  enabled: z.boolean().default(false),
  failIfUnavailable: z.boolean().default(false),
  autoAllowBashIfSandboxed: z.boolean().default(true),
  excludedCommands: z.array(z.string()).default([]),
  allowUnsandboxedCommands: z.boolean().default(true),
  filesystem: z
    .object({
      allowWrite: z.array(z.string()).default([]),
      denyWrite: z.array(z.string()).default([]),
      denyRead: z.array(z.string()).default([]),
    })
    .default({}),
  network: z
    .object({
      allowedDomains: z.array(z.string()).default([]),
      deniedDomains: z.array(z.string()).default([]),
    })
    .default({}),
});

/**
 * Permission configuration (matches CC's permissions key).
 */
/**
 * Per-rule trust decisions for `permissions.allow` entries declared by the
 * checked-in project layer.
 *
 * Unlike an MCP server, a permission rule *is* its own identity: change the
 * rule and it is a different key, so no fingerprint is needed to detect drift.
 * Decisions are stored per workspace in `.book/settings.local.json`, which the
 * repository cannot write.
 */
export const projectAllowRuleChoiceSchema = z.enum(['approved', 'rejected']);

export type ProjectAllowRuleChoice = z.infer<typeof projectAllowRuleChoiceSchema>;

export const permissionsSchema = z.object({
  allow: z.array(permissionRuleSchema).default([]),
  ask: z.array(permissionRuleSchema).default([]),
  deny: z.array(permissionRuleSchema).default([]),
  /**
   * Decisions about `allow` rules the project layer declared. A project rule
   * with no `approved` entry here never reaches the resolved allow list.
   */
  projectAllowRules: z.record(projectAllowRuleChoiceSchema).default({}),
});

/**
 * Hook entry: a shell command that runs at a lifecycle event.
 * Matches Claude Code's hook configuration format.
 */
export const hookEntrySchema = z.object({
  /** Tool(specifier) pattern to filter which events trigger this hook. */
  matcher: z.string().optional(),
  /** Shell command to run (passed through system shell). */
  command: z.string().min(1),
  /** Extra environment variables for this hook. */
  env: z.record(z.string()).default({}),
});

export type HookEntry = z.infer<typeof hookEntrySchema>;

/**
 * Per-entry trust decisions for hook entries declared by the checked-in project
 * layer, keyed by a fingerprint of `{ event, matcher, command, env }`.
 *
 * A hook is a shell command Book executes at lifecycle events, so a project
 * hook with no `approved` entry here never reaches the resolved hooks. Unlike
 * an MCP server record, a hook carries no name — the fingerprint is the key.
 */
export const projectHookChoiceSchema = z.enum(['approved', 'rejected']);

export type ProjectHookChoice = z.infer<typeof projectHookChoiceSchema>;

/** Hook events supported by book. */
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  /**
   * Something a human should know about while nobody is watching: a run parked on
   * a rejected credential, a budget crossing its ceiling, a refused spawn because
   * the disk is nearly full. Wire ntfy/Slack/SMS here as an ordinary shell hook.
   *
   * Only `severity: 'alarm'` is meant to wake anyone; everything else is a line to
   * tail. `hooksSchema` is generated from this array, so the schema cost is one
   * entry.
   */
  'Notification',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Hooks configuration — a map from event name to an array of hook entries.
 */
export const hooksSchema = z.object({
  ...(Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(hookEntrySchema).default([])])) as {
    [K in HookEvent]: z.ZodDefault<z.ZodArray<typeof hookEntrySchema>>;
  }),
  /**
   * Decisions about hook entries the checked-in project layer declared. An
   * entry whose fingerprint has no `approved` record here never reaches the
   * resolved hooks.
   */
  projectEntries: z.record(projectHookChoiceSchema).default({}),
});

export type HooksConfig = z.infer<typeof hooksSchema>;

/**
 * Retry configuration schema — mirrors Claude Code's retry tunables.
 */
export const retrySettingsSchema = z.object({
  maxAttempts: z.number().int().min(0).max(15).default(10),
  baseDelayMs: z.number().int().min(100).max(60000).default(1000),
  maxDelayMs: z.number().int().min(100).max(300000).default(30000),
  totalBudgetMs: z.number().int().min(0).max(600000).default(0),
  requestTimeoutMs: z.number().int().min(5000).max(600000).default(600000),
  streamStallTimeoutMs: z.number().int().min(5000).max(120000).default(20000),
  /**
   * Stall ceiling while the model is thinking, which is a different regime.
   *
   * `streamStallTimeoutMs` is tuned for a chat: 20s of silence means something
   * broke. But with adaptive thinking on — the default for every Opus and Sonnet
   * model here, at `high` effort unless told otherwise — a long quiet stretch
   * before the first token is the model working, not a fault. Applying the chat
   * timeout to it cancels a healthy request and reports `stream_stall`.
   */
  thinkingStallTimeoutMs: z.number().int().min(10_000).max(1_800_000).default(900_000),
  toolRetries: z.number().int().min(0).max(3).default(1),
  watchdog: z.boolean().default(false),
  /**
   * How many times a turn may be re-sent after a transport fault that left the
   * work intact — a stalled stream, a dropped socket.
   *
   * `maxAttempts` covers connection setup only; once a 200 response is streaming
   * it is out of scope, so without this a single 20-second provider silence ended
   * the run. Set to 0 to restore that behavior exactly.
   */
  streamReissueAttempts: z.number().int().min(0).max(10).default(3),
  /**
   * Separate allowance for continuing after the provider's output cap. A large
   * generated file legitimately hits the cap on consecutive turns, and sharing
   * the transport budget would leave nothing for a real socket drop afterwards.
   */
  outputCapContinuations: z.number().int().min(0).max(50).default(10),
});

export type RetrySettings = z.infer<typeof retrySettingsSchema>;

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const providerModelSchema = z.object({
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Whether this model accepts image input. Unknown models remain optimistic. */
  vision: z.boolean().optional(),
  /**
   * Entered by hand rather than returned by the endpoint's model-list API.
   * Refreshing the catalog keeps these, since they exist precisely because
   * discovery does not list them.
   */
  manual: z.boolean().optional(),
  /** Mutation-tool preference for this model; defaults to a family-level prior. */
  editFormat: z.enum(['patch', 'replace', 'whole']).optional(),
  effort: z
    .union([
      z.literal(false),
      z.object({
        default: effortLevelSchema.optional(),
        levels: z.array(effortLevelSchema).optional(),
      }),
    ])
    .optional(),
});

export const providerConfigSchema = z.object({
  type: z.enum(['openai', 'anthropic']).default('openai'),
  baseURL: z.string().min(1).optional(),
  baseUrl: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  models: z.record(providerModelSchema).default({}),
});

/**
 * Continuation: whether a turn that stops with no tool calls may be re-driven.
 *
 * `runAgentLoop` ends as soon as a turn produces no tool calls, so one user
 * message is the whole run and a model that writes "I've finished" stops there.
 * Enabling this lets the loop append a host-authored user turn and keep going
 * while there is demonstrably work left.
 *
 * Off by default: it changes when a run ends, and continuation without the
 * no-progress brake below would let a stalled run spin and bill silently, where
 * today it stops and a human notices.
 */
export const continuationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Consecutive host-authored continuations before the run stops regardless. */
  maxConsecutive: z.number().int().min(1).max(1000).default(50),
  /**
   * Identical progress witnesses in a row before the run stops as no-progress.
   * Minimum 1: a 0 here would fire on the first boundary, before any witness
   * exists, and label a run that never got a chance to spin as spinning.
   */
  noProgressLimit: z.number().int().min(1).max(20).default(3),
  /** Turns between host-authored work-state messages; 0 disables them. */
  planRefreshTurns: z.number().int().min(0).max(500).default(25),
  /** Wall-clock ceiling for one continued run; 0 means no ceiling. */
  maxWallClockMs: z.number().int().min(0).default(0),
});

export type ContinuationSettings = z.infer<typeof continuationSettingsSchema>;

export const memorySettingsSchema = z.object({
  enabled: z.boolean().default(true),
  autoSave: z.boolean().default(true),
  requireApproval: z.boolean().default(true),
});

export const agentSettingsSchema = z.object({
  mode: z.enum(['adaptive', 'manual', 'off']).default('adaptive'),
  maxConcurrent: z.number().int().min(1).max(16).default(3),
  maxSpawned: z.number().int().min(1).max(64).default(8),
  maxDepth: z.literal(1).default(1),
  persist: z.boolean().default(true),
  includeUntrackedInSnapshot: z.boolean().default(true),
  telemetry: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  checks: z.record(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).default({}),
  /**
   * Wall-clock ceiling for one `Check` run. The 120s default suits a focused
   * suite; a full `npm test` on a large repository routinely exceeds it, and a
   * check that always times out is worse than no check because the timeout was
   * reported as a failing suite. Raise it per project rather than per invocation.
   */
  checkTimeoutMs: z.number().int().min(1_000).max(7_200_000).default(120_000),
  /**
   * Simultaneous agent worktrees per repository; 0 disables the check.
   *
   * Nothing reclaims a worktree automatically outside the TUI, and the store's
   * retention sweep runs once at startup with a 30-day default — so on a long
   * unattended run the count only grows. Sized above `maxConcurrent` so ordinary
   * fan-out is unaffected and only accumulation trips it.
   */
  maxWorktrees: z.number().int().min(0).max(256).default(24),
  /**
   * Re-drive agents that were interrupted by process death on the next start.
   *
   * A restart otherwise converts the whole pending backlog into terminal records
   * nothing picks up, silently losing hours of child work on a wide fan-out. The
   * re-drive is contained: explorers are read-only and patchers/validators run in
   * their own worktree, so nothing reaches the parent workspace without the usual
   * evidence gate. Only `process_exit` interruptions qualify — a user stop stays
   * stopped.
   */
  resumeInterrupted: z.boolean().default(true),
  /**
   * Refuse a new worktree when free disk would fall below this; 0 disables.
   * Worktrees share the filesystem with the workspace, so exhausting it breaks
   * the root agent's own Edit and Bash, not just the child's.
   */
  minFreeDiskBytes: z
    .number()
    .int()
    .min(0)
    .default(2 * 1024 * 1024 * 1024),
  profiles: z
    .record(
      z.object({
        model: z.string().min(1).optional(),
        effort: effortLevelSchema.optional(),
        maxTurns: z.number().int().min(1).optional(),
        color: z.string().optional(),
      }),
    )
    .default({}),
  ui: z.object({ enabled: z.boolean().default(true) }).default({}),
  routing: z
    .object({
      inlineSearchBudget: z.number().int().min(1).max(20).default(3),
      exploreReminder: z.boolean().default(true),
    })
    .default({}),
  forwardTextEvents: z.boolean().default(false),
});

export const toolDiscoverySettingsSchema = z.object({
  mode: z.enum(['auto', 'eager', 'deferred']).default('auto'),
  eagerToolCount: z.number().int().min(1).max(100).default(10),
  schemaTokenBudget: z.number().int().min(1000).max(100000).default(8000),
  maxLoadedTools: z.number().int().min(1).max(100).default(15),
  searchLimit: z.number().int().min(1).max(5).default(5),
});

export type ToolDiscoverySettings = z.infer<typeof toolDiscoverySettingsSchema>;

export const toolExecutionSettingsSchema = z.object({
  /** Shared across the root loop and managed children for parallel-safe tools. */
  maxConcurrent: z.number().int().min(1).max(8).default(4),
});

export type ToolExecutionSettings = z.infer<typeof toolExecutionSettingsSchema>;

export const observabilitySettingsSchema = z.object({
  /** Persist a per-tool-call JSONL record for `book tool-stats`. */
  toolTelemetry: z.boolean().default(true),
  /**
   * Default reporting window (in days) for `book tool-stats` and the target for
   * `book tool-stats --prune`. Disk use is bounded by size-based log rotation;
   * records are only deleted when they rotate out or are explicitly pruned.
   */
  toolTelemetryRetentionDays: z.number().int().min(1).max(3650).default(30),
});

export type ObservabilitySettings = z.infer<typeof observabilitySettingsSchema>;

export const harnessModeSchema: z.ZodType<HarnessMode> = z.enum([
  'off',
  'observe',
  'shadow',
  'active',
  'learn',
]);

export const harnessSettingsSchema = z.object({
  mode: harnessModeSchema.default('off'),
  /**
   * Explicit workflow selection by registry ID. Requires an enabled harness
   * mode: under `off` there is no run evidence to record the choice against, so
   * a selection fails closed rather than silently changing behavior.
   */
  workflow: z.string().regex(WORKFLOW_ID_PATTERN, WORKFLOW_ID_MESSAGE).optional(),
});

export type HarnessSettings = z.infer<typeof harnessSettingsSchema>;

export const mcpProjectServerChoiceSchema = z.object({
  /** Hash of the server's command/args/env at decision time; a mismatch re-prompts. */
  fingerprint: z.string().min(1),
  choice: z.enum(['approved', 'rejected']),
});

export type McpProjectServerChoice = z.infer<typeof mcpProjectServerChoiceSchema>;

export const mcpSettingsSchema = z.object({
  /**
   * Per-server trust decisions for workspace `.mcp.json` declarations.
   * User-global servers (<BOOK_HOME>/.book/mcp.json) never require approval.
   */
  projectServers: z.record(mcpProjectServerChoiceSchema).default({}),
});

export type McpSettings = z.infer<typeof mcpSettingsSchema>;

export const projectCommandChoiceSchema = z.object({
  /** Digest of the shell the body substitutes at decision time; a mismatch re-prompts. */
  fingerprint: z.string().min(1),
  choice: z.enum(['approved', 'rejected']),
});

export type ProjectCommandChoice = z.infer<typeof projectCommandChoiceSchema>;

export const commandSettingsSchema = z.object({
  /**
   * Per-command trust decisions for `<workspace>/.book/commands/*.md` files
   * that substitute shell into their prompt. That substitution runs outside the
   * permission system and outside the sandbox, so a repository-controlled file
   * needs a decision before it runs. User-global commands
   * (<BOOK_HOME>/commands) were written by the user and never require one.
   */
  projectCommands: z.record(projectCommandChoiceSchema).default({}),
});

export type CommandSettings = z.infer<typeof commandSettingsSchema>;

export const uiSettingsSchema = z.object({
  /** Show provider-native and embedded model reasoning in the interactive transcript. */
  showThinking: z.boolean().default(true),
  /** Play the full-screen fire sequence on a newly created interactive startup session. */
  startupAnimation: z.boolean().default(true),
});

export type UiSettings = z.infer<typeof uiSettingsSchema>;

export const skillActivationSchema = z.enum(['auto', 'name-only', 'manual', 'off']);
export type SkillActivation = z.infer<typeof skillActivationSchema>;

export const skillExecutionSchema = z.enum(['inherit', 'ask', 'deny']);
export type SkillExecution = z.infer<typeof skillExecutionSchema>;

export const skillSettingsSchema = z.object({
  /** Emergency switch that removes skill prompt and runtime effects without deleting packages. */
  enabled: z.boolean().default(true),
  /** Per-skill visibility overrides keyed by the skill's declared name. */
  overrides: z.record(skillActivationSchema).default({}),
  /** Per-skill activation consent policy. Tool calls still use the normal permission system. */
  execution: z.record(skillExecutionSchema).default({}),
});

export type SkillSettings = z.infer<typeof skillSettingsSchema>;

export type ProviderModelConfig = z.infer<typeof providerModelSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** The supported production strategy; Zero-Mem is gated separately as experimental. */
export const compactStrategySchema = z.literal('summary');
export type CompactStrategy = z.infer<typeof compactStrategySchema>;

export const experimentalSettingsSchema = z.object({
  /** Experimental query-time Zero-Mem retrieval. Disabled unless explicitly enabled. */
  zeroMem: z.boolean().default(false),
});

export type ExperimentalSettings = z.infer<typeof experimentalSettingsSchema>;

/**
 * Full settings.json schema — all keys that book supports.
 * New keys added in later milestones extend this schema.
 */
export const bookSettingsSchema = z.object({
  model: z.string().optional(),
  /** Default strategy used to reduce historical conversation context. */
  compactStrategy: compactStrategySchema.optional(),
  /** Unstable features that are unavailable under shipped defaults. */
  experimental: experimentalSettingsSchema.default({}),
  /** Optional model used only to generate historical conversation checkpoints. */
  compactModel: z.string().min(1).optional(),
  /** Max agent turns per user message. Omit for unlimited. */
  maxTurns: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1000).optional(),
  effort: effortLevelSchema.optional(),
  /** TUI color theme: dark, light, auto, or a custom theme filename. */
  theme: z.string().min(1).optional(),
  ui: uiSettingsSchema.default({}),
  skills: skillSettingsSchema.default({}),
  autoCompactEnabled: z.boolean().optional(),
  /** Permission mode used by each host when no invocation-specific mode is supplied. */
  defaultMode: z
    .enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
    .optional(),
  disableBypassPermissionsMode: z.boolean().optional(),
  additionalDirectories: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  provider: z.record(providerConfigSchema).default({}),
  permissions: permissionsSchema.default({}),
  sandbox: sandboxSchema.default({}),
  hooks: hooksSchema.default({}),
  retry: retrySettingsSchema.default({}),
  memory: memorySettingsSchema.default({}),
  continuation: continuationSettingsSchema.default({}),
  agents: agentSettingsSchema.default({}),
  toolDiscovery: toolDiscoverySettingsSchema.default({}),
  toolExecution: toolExecutionSettingsSchema.default({}),
  observability: observabilitySettingsSchema.default({}),
  harness: harnessSettingsSchema.default({}),
  mcp: mcpSettingsSchema.default({}),
  commands: commandSettingsSchema.default({}),
});

export type BookSettings = z.infer<typeof bookSettingsSchema>;

/**
 * Resolved settings after layering (all defaults filled).
 */
export type ResolvedSettings = Required<
  Omit<
    BookSettings,
    | 'model'
    | 'compactModel'
    | 'maxTurns'
    | 'maxTokens'
    | 'effort'
    | 'theme'
    | 'autoCompactEnabled'
    | 'defaultMode'
    | 'disableBypassPermissionsMode'
  >
> &
  Pick<
    BookSettings,
    | 'model'
    | 'compactModel'
    | 'maxTurns'
    | 'maxTokens'
    | 'effort'
    | 'theme'
    | 'autoCompactEnabled'
    | 'defaultMode'
    | 'disableBypassPermissionsMode'
  >;

/**
 * Default settings used as the base layer before user/project/local override.
 */
export const DEFAULT_SETTINGS: ResolvedSettings = {
  compactStrategy: 'summary',
  experimental: { zeroMem: false },
  permissions: { allow: [], ask: [], deny: [], projectAllowRules: {} },
  sandbox: {
    enabled: false,
    failIfUnavailable: false,
    autoAllowBashIfSandboxed: true,
    excludedCommands: [],
    allowUnsandboxedCommands: true,
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  },
  hooks: {
    SessionStart: [],
    SessionEnd: [],
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
    PreCompact: [],
    PostCompact: [],
    SubagentStart: [],
    SubagentStop: [],
    Notification: [],
    projectEntries: {},
  },
  additionalDirectories: [],
  env: {},
  provider: {},
  ui: { showThinking: true, startupAnimation: true },
  skills: { enabled: true, overrides: {}, execution: {} },
  retry: {
    maxAttempts: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    totalBudgetMs: 0,
    requestTimeoutMs: 600000,
    streamStallTimeoutMs: 20000,
    thinkingStallTimeoutMs: 900_000,
    toolRetries: 1,
    watchdog: false,
    streamReissueAttempts: 3,
    outputCapContinuations: 10,
  },
  continuation: {
    enabled: false,
    maxConsecutive: 50,
    noProgressLimit: 3,
    planRefreshTurns: 25,
    maxWallClockMs: 0,
  },
  memory: {
    enabled: true,
    autoSave: true,
    requireApproval: true,
  },
  agents: {
    mode: 'adaptive',
    maxConcurrent: 3,
    maxSpawned: 8,
    maxDepth: 1,
    persist: true,
    includeUntrackedInSnapshot: true,
    telemetry: true,
    retentionDays: 30,
    checks: {},
    checkTimeoutMs: 120_000,
    maxWorktrees: 24,
    resumeInterrupted: true,
    minFreeDiskBytes: 2 * 1024 * 1024 * 1024,
    profiles: {},
    ui: { enabled: true },
    routing: { inlineSearchBudget: 3, exploreReminder: true },
    forwardTextEvents: false,
  },
  toolDiscovery: {
    mode: 'auto',
    eagerToolCount: 10,
    schemaTokenBudget: 8000,
    maxLoadedTools: 15,
    searchLimit: 5,
  },
  toolExecution: {
    maxConcurrent: 4,
  },
  observability: {
    toolTelemetry: true,
    toolTelemetryRetentionDays: 30,
  },
  harness: {
    mode: 'off',
  },
  mcp: {
    projectServers: {},
  },
  commands: {
    projectCommands: {},
  },
};
