import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createProvider } from '../provider/index.js';
import type { AgentRunAmbientSnapshot } from '../types/runs.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { ToolDefinition } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import { resolveBookHome } from '../book-home.js';
import { resolvePermissionMode } from '../permission-mode.js';

const AMBIENT_SCHEMA_VERSION = 1 as const;
const ENVIRONMENT_KEYS = /^(BOOK_|CI$|NO_COLOR$|TERM$|TZ$)/;

export interface RunAmbientSnapshotOptions {
  capturedAt?: number;
  permissionMode?: PermissionMode;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized.endsWith('apikey') ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized === 'authorization' ||
    normalized === 'token' ||
    normalized.endsWith('authtoken') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('bearertoken')
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function sanitize(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) return value ? '<configured>' : '<unset>';
  if (typeof value === 'function') return '<function>';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') {
    if (key === 'env') {
      return Object.keys(value as Record<string, unknown>).sort();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([childKey, item]) => [childKey, sanitize(item, childKey)]),
    );
  }
  return value;
}

function endpointFingerprint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return fingerprint(url.toString());
  } catch {
    return fingerprint('<invalid-provider-endpoint>');
  }
}

function toolProjection(definition: ToolDefinition): Record<string, unknown> {
  const catalog = definition.catalog
    ? Object.fromEntries(Object.entries(definition.catalog).filter(([key]) => key !== 'available'))
    : undefined;
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema ?? definition.parameters,
    argumentAliases: definition.argumentAliases,
    arrayItemArgumentAliases: definition.arrayItemArgumentAliases,
    catalog,
    policy: definition.policy,
    idempotent: definition.idempotent,
  };
}

function environmentProjection(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && ENVIRONMENT_KEYS.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, isSensitiveKey(key) ? '<configured>' : (value as string)]),
  );
}

export function createRunAmbientSnapshot(
  config: AgentConfig,
  registry: ToolRegistry,
  options: RunAmbientSnapshotOptions | number = {},
): AgentRunAmbientSnapshot {
  const resolvedOptions = typeof options === 'number' ? { capturedAt: options } : options;
  const capturedAt = resolvedOptions.capturedAt ?? Date.now();
  const provider = createProvider(config);
  const definitions = (
    typeof registry.getDefinitions === 'function' ? registry.getDefinitions() : []
  )
    .map(toolProjection)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const settingsProjection = sanitize(config.settings);
  const memoryProjection = config.memoryContext
    ? {
        indexLoaded: config.memoryContext.indexLoaded,
        indexText: config.memoryContext.indexText,
        files: config.memoryContext.files
          .map((file) => ({
            name: file.name,
            type: file.type,
            status: file.status,
            size: file.size,
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }
    : null;
  const environment = environmentProjection();
  const model = {
    provider: provider.id,
    requestedModel: config.model,
    modelSelection: config.modelSelection,
    endpointFingerprint: endpointFingerprint(config.baseUrl),
    effort: config.effort,
    maxTokens: config.maxTokens,
    maxTurns: config.maxTurns,
    modelInfoFingerprint: fingerprint(sanitize(config.modelInfo)),
  };
  const settings = {
    fingerprint: fingerprint(settingsProjection),
    agentsMode: config.settings.agents.mode,
  };
  const tools = {
    fingerprint: fingerprint(definitions),
    count: definitions.length,
    names: definitions.map((definition) => String(definition.name)),
  };
  const memory = {
    fingerprint: fingerprint(memoryProjection),
    enabled: config.settings.memory.enabled,
    indexLoaded: config.memoryContext?.indexLoaded ?? false,
  };
  const policies = {
    permissionMode: resolvePermissionMode(config.settings, resolvedOptions.permissionMode),
    hooksFingerprint: fingerprint(sanitize(config.settings.hooks)),
    contextFingerprint: fingerprint({
      autoCompactEnabled: config.autoCompactEnabled,
      maxTokens: config.maxTokens,
      memory: memoryProjection,
      toolDiscovery: sanitize(config.settings.toolDiscovery),
    }),
    networkFingerprint: fingerprint({
      endpoint: model.endpointFingerprint,
      sandbox: sanitize(config.settings.sandbox),
    }),
    delegationFingerprint: fingerprint(sanitize(config.settings.agents)),
  };
  const runtime = {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    environmentFingerprint: fingerprint(environment),
    workspaceFingerprint: fingerprint(resolve(config.workspace)),
  };
  const bookHome = {
    pathFingerprint: fingerprint(resolveBookHome()),
    isolation: process.env.BOOK_HOME?.trim() ? ('configured' as const) : ('shared' as const),
  };
  const missingSources = [
    'book_home_contents',
    'book_home_isolation',
    'clock_control',
    'command_registry',
    'mcp_registry',
    'prompt_layers',
    'random_seed',
    'repository_revision',
    'runtime_code_version',
    'settings_env_values',
    'skill_registry',
    'tool_activation_state',
  ] as const;
  const comparable = {
    schemaVersion: AMBIENT_SCHEMA_VERSION,
    model,
    settings,
    tools,
    memory,
    policies,
    runtime,
    bookHome,
    completeness: 'partial' as const,
    missingSources,
  };

  return deepFreeze({
    ...comparable,
    fingerprint: fingerprint(comparable),
    capturedAt,
  });
}
