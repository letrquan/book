import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  SYSTEM_PROMPT_VERSION,
  normalizePromptPath,
  promptCurrentDate,
} from '../agent/prompt-determinism.js';
import { resolveAgentProfile } from '../agents/profile-resolver.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverProjectInstructions } from '../claude-md.js';
import { createProvider } from '../provider/index.js';
import { discoverCommands } from '../commands/loader.js';
import { loadMcpConfig } from '../mcp-config.js';
import { discoverSkills, loadSkillBody } from '../skills.js';
import { discoverAgents } from '../subagent-discovery.js';
import type { AgentRunAmbientSnapshot } from '../types/runs.js';
import type { SlashCommand } from '../types/commands.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { Skill } from '../skills.js';
import type { ToolDefinition } from '../types/tools.js';
import type { ToolRegistry } from '../tools/registry.js';
import { resolveBookHome } from '../book-home.js';
import { HOOK_EVENTS } from '../settings.js';
import { resolvePermissionMode } from '../permission-mode.js';
import { getPackageVersion } from '../version-info.js';

const AMBIENT_SCHEMA_VERSION = 2 as const;
const ENVIRONMENT_KEYS = /^(BOOK_|CI$|NO_COLOR$|TERM$|TZ$)/;
const DEFAULT_BOOK_HOME_CAPTURE_LIMITS = {
  maxFiles: 1_000,
  maxBytes: 10 * 1024 * 1024,
} as const;

export interface RunAmbientSnapshotOptions {
  capturedAt?: number;
  permissionMode?: PermissionMode;
  commands?: readonly SlashCommand[];
  skills?: readonly Skill[];
  systemPromptAppend?: string;
  hideAgents?: boolean;
  planMode?: boolean;
  allowedTools?: readonly string[];
  bookHomeCaptureLimits?: {
    maxFiles: number;
    maxBytes: number;
  };
}

interface BookHomeContentsCapture {
  fingerprint: string;
  fileCount: number;
  totalBytes: number;
  status: 'captured' | 'incomplete';
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

function commandProjection(command: SlashCommand): Record<string, unknown> {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    arguments: command.arguments,
    allowedTools: command.allowedTools,
    model: command.model,
    bodyDigest: fingerprint(command.body),
    source: command.source,
    isHidden: command.isHidden,
    userInvocable: command.userInvocable,
  };
}

function skillProjection(skill: Skill): Record<string, unknown> {
  let bodyDigest = '<unavailable>';
  try {
    bodyDigest = loadSkillBody(skill).digest;
  } catch {
    // Invalid or concurrently changed skills remain represented by their issue state.
  }
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
    model: skill.model,
    lifetime: skill.lifetime,
    source: skill.source,
    rootKind: skill.rootKind,
    version: skill.version,
    activation: skill.activation,
    execution: skill.execution,
    bodyDigest,
    resources: skill.resources.map(({ relativePath, byteSize, digest }) => ({
      relativePath,
      byteSize,
      digest,
    })),
    valid: skill.valid,
    issues: skill.issues,
  };
}

function mcpProjection(config: AgentConfig): Array<Record<string, unknown>> {
  return Object.entries(loadMcpConfig(config.workspace))
    .map(([name, server]) => ({
      name,
      transport: server.type ?? (server.url ? 'http' : 'stdio'),
      command: server.command,
      args: server.args,
      envKeys: Object.keys(server.env ?? {}).sort(),
      cwd: server.cwd,
      url: server.url,
      headerKeys: Object.keys(server.headers ?? {}).sort(),
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function agentProjection(config: AgentConfig): Array<Record<string, unknown>> {
  return withBuiltInAgents(discoverAgents(config.workspace))
    .map((definition) => {
      const resolved = resolveAgentProfile(definition, config);
      return {
        name: definition.name,
        description: definition.description,
        allowedTools: definition.allowedTools,
        bodyDigest: fingerprint(definition.body),
        source: definition.source,
        role: definition.role,
        isolation: definition.isolation,
        requestedModel: resolved.requestedModel,
        resolvedModel: resolved.resolvedModel,
        provider: resolved.provider,
        effort: resolved.effort,
        maxTurns: resolved.maxTurns,
      };
    })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function projectInstructionProjection(config: AgentConfig): Array<Record<string, unknown>> {
  return discoverProjectInstructions(config.workspace).map((source, index) => ({
    index,
    layer: source.layer,
    path: normalizePromptPath(source.path, config.workspace),
    bodyDigest: fingerprint(source.body),
  }));
}

function environmentProjection(evaluationIsolation: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && ENVIRONMENT_KEYS.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        if (evaluationIsolation && key === 'BOOK_HOME') return [key, '<evaluation-book-home>'];
        if (key === 'BOOK_EVALUATION_RUN_ID') return [key, '<configured>'];
        return [key, isSensitiveKey(key) ? '<configured>' : (value as string)];
      }),
  );
}

function captureBookHomeContents(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): BookHomeContentsCapture {
  const entries: Array<Record<string, unknown>> = [];
  let fileCount = 0;
  let totalBytes = 0;
  let incomplete = !existsSync(root);

  const readBoundedFile = (path: string, remainingBytes: number): Buffer | undefined => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, 'r');
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size > remainingBytes) return undefined;
      const content = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < content.byteLength) {
        const read = readSync(descriptor, content, offset, content.byteLength - offset, offset);
        if (read === 0) return undefined;
        offset += read;
      }
      const extra = Buffer.alloc(1);
      if (readSync(descriptor, extra, 0, 1, offset) > 0) return undefined;
      return content;
    } catch {
      return undefined;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Descriptor teardown is best effort after a bounded read attempt.
        }
      }
    }
  };

  const visit = (directory: string, relativeDirectory = ''): void => {
    if (incomplete) return;
    let children: Dirent[];
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      incomplete = true;
      return;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (child.isSymbolicLink()) {
        incomplete = true;
        continue;
      }
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' });
        visit(path, relativePath);
        continue;
      }
      if (!child.isFile() || fileCount >= limits.maxFiles) {
        incomplete = true;
        continue;
      }
      try {
        const content = readBoundedFile(path, limits.maxBytes - totalBytes);
        if (!content) {
          incomplete = true;
          continue;
        }
        fileCount += 1;
        totalBytes += content.byteLength;
        entries.push({
          path: relativePath,
          type: 'file',
          bytes: content.byteLength,
          digest: createHash('sha256').update(content).digest('hex'),
        });
      } catch {
        incomplete = true;
      }
    }
  };

  visit(root);
  return {
    fingerprint: fingerprint(entries),
    fileCount,
    totalBytes,
    status: incomplete ? 'incomplete' : 'captured',
  };
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
  const commandDefinitions = [...(resolvedOptions.commands ?? discoverCommands(config.workspace))]
    .map(commandProjection)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const skillDefinitions = [
    ...(resolvedOptions.skills ??
      discoverSkills(config.workspace, config.settings.skills.overrides, {
        executionOverrides: config.settings.skills.execution,
        enabled: config.settings.skills.enabled,
      })),
  ]
    .map(skillProjection)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const mcpDefinitions = mcpProjection(config);
  const agentDefinitions = agentProjection(config);
  const projectInstructions = projectInstructionProjection(config);
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
  const evaluationIsolation = Boolean(
    process.env.BOOK_HOME?.trim() && process.env.BOOK_EVALUATION_RUN_ID?.trim(),
  );
  const evaluationDate = process.env.BOOK_EVALUATION_DATE?.trim();
  const evaluationRandomSeed = process.env.BOOK_EVALUATION_RANDOM_SEED?.trim();
  const evaluationRuntimeRevision = process.env.BOOK_EVALUATION_RUNTIME_REVISION?.trim();
  const evaluationFixtureRevision = process.env.BOOK_EVALUATION_FIXTURE_REVISION?.trim();
  const environment = environmentProjection(evaluationIsolation);
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
    activationState: evaluationIsolation ? ('fresh' as const) : ('unverified' as const),
  };
  const commands = {
    fingerprint: fingerprint(commandDefinitions),
    count: commandDefinitions.length,
    names: commandDefinitions.map((definition) => String(definition.name)),
  };
  const skills = {
    fingerprint: fingerprint(skillDefinitions),
    count: skillDefinitions.length,
    names: skillDefinitions.map((definition) => String(definition.name)),
    activationState: config.settings.skills.enabled
      ? ('not-captured' as const)
      : ('disabled' as const),
  };
  const mcp = {
    fingerprint: fingerprint(mcpDefinitions),
    count: mcpDefinitions.length,
    names: mcpDefinitions.map((definition) => String(definition.name)),
  };
  const agents = {
    fingerprint: fingerprint(agentDefinitions),
    count: agentDefinitions.length,
    names: agentDefinitions.map((definition) => String(definition.name)),
    mode: config.settings.agents.mode,
  };
  const promptProjection = {
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    date: promptCurrentDate(),
    projectInstructions,
    systemPromptAppendDigest: fingerprint(resolvedOptions.systemPromptAppend ?? null),
    hideAgents: resolvedOptions.hideAgents ?? false,
    planMode: resolvedOptions.planMode ?? resolvedOptions.permissionMode === 'plan',
    allowedTools: [...(resolvedOptions.allowedTools ?? [])].sort(),
  };
  const prompt = {
    fingerprint: fingerprint(promptProjection),
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    date: promptProjection.date,
    projectInstructionCount: projectInstructions.length,
  };
  const memory = {
    fingerprint: fingerprint(memoryProjection),
    enabled: config.settings.memory.enabled,
    indexLoaded: config.memoryContext?.indexLoaded ?? false,
  };
  const policies = {
    permissionMode: resolvePermissionMode(config.settings, resolvedOptions.permissionMode),
    // The event arrays only: `hooks.projectEntries` records trust decisions, not
    // hooks. Rejecting an entry changes nothing about what executes, so it must
    // not give two behaviourally identical runs different ambient identities.
    hooksFingerprint: fingerprint(
      sanitize(
        Object.fromEntries(HOOK_EVENTS.map((event) => [event, config.settings.hooks[event]])),
      ),
    ),
    contextFingerprint: fingerprint({
      autoCompactEnabled: config.autoCompactEnabled,
      compactStrategy: config.compactStrategy,
      experimentalZeroMem: config.experimentalZeroMem,
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
    packageVersion: getPackageVersion(),
    runtimeRevision: evaluationRuntimeRevision ?? '<uncontrolled>',
    fixtureRevision: evaluationFixtureRevision ?? '<uncontrolled>',
    randomSeed: evaluationRandomSeed ?? '<uncontrolled>',
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    environmentFingerprint: fingerprint(environment),
    workspaceFingerprint: fingerprint(
      evaluationIsolation ? '<evaluation-workspace>' : resolve(config.workspace),
    ),
  };
  const bookHomePath = resolveBookHome();
  const bookHomeContents = evaluationIsolation
    ? captureBookHomeContents(
        bookHomePath,
        resolvedOptions.bookHomeCaptureLimits ?? DEFAULT_BOOK_HOME_CAPTURE_LIMITS,
      )
    : undefined;
  const bookHome = {
    pathFingerprint: fingerprint(evaluationIsolation ? '<evaluation-book-home>' : bookHomePath),
    isolation: evaluationIsolation
      ? ('isolated' as const)
      : process.env.BOOK_HOME?.trim()
        ? ('configured' as const)
        : ('shared' as const),
    contentsFingerprint: bookHomeContents?.fingerprint,
    contentsStatus: bookHomeContents?.status ?? ('not-captured' as const),
    fileCount: bookHomeContents?.fileCount,
    totalBytes: bookHomeContents?.totalBytes,
  };
  const missingSources = [
    ...(evaluationDate && /^\d{4}-\d{2}-\d{2}$/.test(evaluationDate)
      ? []
      : ['clock_control' as const]),
    ...(evaluationRandomSeed ? [] : ['random_seed' as const]),
    ...(evaluationFixtureRevision && evaluationFixtureRevision !== '<incomplete>'
      ? []
      : ['repository_revision' as const]),
    ...(evaluationRuntimeRevision && evaluationRuntimeRevision !== 'unknown'
      ? []
      : ['runtime_code_version' as const]),
    ...(evaluationIsolation ? [] : ['settings_env_values' as const]),
    ...(skills.activationState === 'disabled' && evaluationIsolation
      ? []
      : ['tool_activation_state' as const]),
    ...(config.settings.skills.enabled ? ['skill_activation_state' as const] : []),
    ...(bookHome.isolation === 'isolated' ? [] : ['book_home_isolation' as const]),
    ...(bookHome.contentsStatus === 'captured' ? [] : ['book_home_contents' as const]),
  ] as const;
  const completeness = missingSources.length === 0 ? ('complete' as const) : ('partial' as const);
  const comparable = {
    schemaVersion: AMBIENT_SCHEMA_VERSION,
    model,
    settings,
    tools,
    commands,
    skills,
    mcp,
    agents,
    prompt,
    memory,
    policies,
    runtime,
    bookHome,
    completeness,
    missingSources,
  };

  return deepFreeze({
    ...comparable,
    fingerprint: fingerprint(comparable),
    capturedAt,
  });
}
