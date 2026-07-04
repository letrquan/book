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
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Hooks configuration — a map from event name to an array of hook entries.
 */
export const hooksSchema = z.object(
  Object.fromEntries(
    HOOK_EVENTS.map((e) => [e, z.array(hookEntrySchema).default([])]),
  ) as { [K in HookEvent]: z.ZodDefault<z.ZodArray<typeof hookEntrySchema>> },
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

export type ProviderModelConfig = z.infer<typeof providerModelSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * Full settings.json schema — all keys that book supports.
 * New keys added in later milestones extend this schema.
 */
export const bookSettingsSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxTokens: z.number().int().min(1000).optional(),
  effort: effortLevelSchema.optional(),
  autoCompactEnabled: z.boolean().optional(),
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
});

export type BookSettings = z.infer<typeof bookSettingsSchema>;

/**
 * Resolved settings after layering (all defaults filled).
 */
export type ResolvedSettings = Required<
  Omit<BookSettings, 'model' | 'maxTurns' | 'maxTokens' | 'effort' | 'autoCompactEnabled' | 'defaultMode' | 'disableBypassPermissionsMode'>
> & Pick<BookSettings, 'model' | 'maxTurns' | 'maxTokens' | 'effort' | 'autoCompactEnabled' | 'defaultMode' | 'disableBypassPermissionsMode'>;

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
  },
  additionalDirectories: [],
  env: {},
  provider: {},
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
};
