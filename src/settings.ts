import { z } from 'zod';

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
export const permissionsSchema = z.object({
  allow: z.array(permissionRuleSchema).default([]),
  ask: z.array(permissionRuleSchema).default([]),
  deny: z.array(permissionRuleSchema).default([]),
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
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Hooks configuration — a map from event name to an array of hook entries.
 */
export const hooksSchema = z.object(
  Object.fromEntries(HOOK_EVENTS.map((e) => [e, z.array(hookEntrySchema).default([])])) as {
    [K in HookEvent]: z.ZodDefault<z.ZodArray<typeof hookEntrySchema>>;
  },
);

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
  toolRetries: z.number().int().min(0).max(3).default(1),
  watchdog: z.boolean().default(false),
});

export type RetrySettings = z.infer<typeof retrySettingsSchema>;

export const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const providerModelSchema = z.object({
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Whether this model accepts image input. Unknown models remain optimistic. */
  vision: z.boolean().optional(),
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

export const uiSettingsSchema = z.object({
  /** Show provider-native and embedded model reasoning in the interactive transcript. */
  showThinking: z.boolean().default(true),
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

/**
 * Full settings.json schema — all keys that book supports.
 * New keys added in later milestones extend this schema.
 */
export const bookSettingsSchema = z.object({
  model: z.string().optional(),
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
  agents: agentSettingsSchema.default({}),
  toolDiscovery: toolDiscoverySettingsSchema.default({}),
  toolExecution: toolExecutionSettingsSchema.default({}),
  observability: observabilitySettingsSchema.default({}),
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
  permissions: { allow: [], ask: [], deny: [] },
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
  },
  additionalDirectories: [],
  env: {},
  provider: {},
  ui: { showThinking: true },
  skills: { enabled: true, overrides: {}, execution: {} },
  retry: {
    maxAttempts: 10,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    totalBudgetMs: 0,
    requestTimeoutMs: 600000,
    streamStallTimeoutMs: 20000,
    toolRetries: 1,
    watchdog: false,
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
};
