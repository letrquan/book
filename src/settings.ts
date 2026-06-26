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
 * Full settings.json schema — all keys that book supports.
 * New keys added in later milestones extend this schema.
 */
export const bookSettingsSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  maxTokens: z.number().int().min(1000).optional(),
  autoCompactEnabled: z.boolean().optional(),
  defaultMode: z
    .enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
    .optional(),
  disableBypassPermissionsMode: z.boolean().optional(),
  additionalDirectories: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  permissions: permissionsSchema.default({}),
  sandbox: sandboxSchema.default({}),
});

export type BookSettings = z.infer<typeof bookSettingsSchema>;

/**
 * Resolved settings after layering (all defaults filled).
 */
export type ResolvedSettings = Required<
  Omit<BookSettings, 'model' | 'maxTurns' | 'maxTokens' | 'autoCompactEnabled' | 'defaultMode' | 'disableBypassPermissionsMode'>
> & Pick<BookSettings, 'model' | 'maxTurns' | 'maxTokens' | 'autoCompactEnabled' | 'defaultMode' | 'disableBypassPermissionsMode'>;

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
  additionalDirectories: [],
  env: {},
};
