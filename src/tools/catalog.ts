import Fuse from 'fuse.js';
import type { AgentConfig } from '../types/runtime.js';
import type {
  ToolCall,
  ToolCatalogMetadata,
  ToolCategory,
  ToolContext,
  ToolDefinition,
  ToolDiscoveryContext,
  ToolDiscoveryState,
  ToolEffect,
  ToolSearchMatch,
} from '../types/tools.js';
import { estimateTokens } from '../context-report.js';
import { resolveContextLimit } from '../models.js';
import { canonicalToolName, TOOL_ALIASES } from './aliases.js';
import {
  isToolCallAllowed,
  isToolDefinitionAllowed,
  parseCapabilityRules,
  type CapabilityRule,
} from './capability-rules.js';
import { READ_ONLY_PLAN_TOOLS } from './plan-mode.js';
import { normalizeToolSchema } from './schema.js';
import { toolSearchTools } from './tool-search.js';
import { isFileMutatingTool } from './tool-capabilities.js';

const ALWAYS_CORE = new Set(['Read', 'Glob', 'Grep', 'AskUserQuestion', 'TodoWrite', 'ToolSearch']);
const MUTATION_CORE = new Set(['ApplyPatch', 'Write', 'Edit', 'MultiEdit', 'Bash']);
const MANAGED_TASK_CORE = new Set(['TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate']);
const RUNTIME_CORE = new Set(['BashOutput', 'KillShell']);
const ROOT_ONLY = new Set([
  'AgentPlan',
  'AgentSpawn',
  'AgentList',
  'AgentGet',
  'AgentRead',
  'AgentSend',
  'AgentWait',
  'AgentStop',
  'AgentApply',
]);
const CHILD_ONLY = new Set(['EvidencePublish', 'EvidenceReview']);

function categoryFor(name: string): ToolCategory {
  if (name.startsWith('mcp__')) return 'mcp';
  if (['Read', 'ApplyPatch', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'].includes(name))
    return 'filesystem';
  if (['Bash', 'BashOutput', 'KillShell'].includes(name)) return 'shell';
  if (name.startsWith('Git')) return 'git';
  if (name.startsWith('Web')) return 'web';
  if (name.startsWith('Agent') || name === 'Task') return 'agents';
  if (name.startsWith('Evidence') || name === 'Check') return 'evidence';
  if (name.startsWith('Task') || name === 'TodoWrite') return 'tasks';
  if (name.includes('PlanMode')) return 'planning';
  if (name === 'InvokeSkill') return 'skills';
  if (name.startsWith('SessionHistory')) return 'session';
  if (name.startsWith('Notebook')) return 'notebook';
  return 'other';
}

function namespaceFor(name: string): string | undefined {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name);
  return match?.[1];
}

function aliasesFor(name: string): string[] {
  return Object.entries(TOOL_ALIASES)
    .filter(([, canonical]) => canonical === name)
    .map(([alias]) => alias);
}

function keywordsFor(name: string): string[] {
  const common: Record<string, string[]> = {
    GitStatus: ['working tree', 'changes'],
    GitDiff: ['changes', 'patch'],
    GitLog: ['history', 'commits'],
    GitCommit: ['save changes', 'commit'],
    GitBranch: ['branches'],
    SessionHistorySearch: ['conversation', 'transcript', 'past session'],
    SessionHistoryRead: ['conversation', 'transcript', 'past session'],
    InvokeSkill: ['workflow', 'instructions'],
    AgentSpawn: ['delegate', 'subagent', 'parallel'],
    AgentRead: ['subagent', 'result', 'output', 'continuation'],
    WebSearch: ['internet', 'research'],
    WebFetch: ['url', 'page', 'download'],
  };
  return common[name] ?? [];
}

function exposureFor(name: string): NonNullable<ToolCatalogMetadata['exposure']> {
  if (ALWAYS_CORE.has(name) || MUTATION_CORE.has(name) || MANAGED_TASK_CORE.has(name))
    return 'core';
  if (RUNTIME_CORE.has(name) || name === 'EnterPlanMode' || name === 'ExitPlanMode')
    return 'runtime';
  return 'deferred';
}

function effectsFor(name: string, category: ToolCategory): ToolEffect[] {
  if (isFileMutatingTool(name) || name === 'NotebookEdit') return ['write'];
  if (['Read', 'Glob', 'Grep', 'BashOutput'].includes(name)) return ['read'];
  if (name === 'Bash' || name === 'KillShell') return ['execute'];
  if (name.startsWith('Web')) return ['network', 'read'];
  if (name === 'AskUserQuestion' || name.includes('PlanMode')) return ['interactive'];
  if (name.startsWith('Agent') || name === 'Task') return ['delegate'];
  if (name === 'EvidencePublish') return ['write'];
  if (name === 'EvidenceReview' || name === 'Check') return ['read', 'execute'];
  if (name.startsWith('Task') || name === 'TodoWrite') return ['write'];
  if (name.startsWith('SessionHistory') || name === 'InvokeSkill') return ['read'];
  if (name === 'GitCommit' || name === 'GitBranch') return ['write', 'execute'];
  if (name.startsWith('Git')) return ['read'];
  if (category === 'mcp') return ['network', 'execute'];
  return ['execute'];
}

function summaryFor(definition: ToolDefinition): string {
  const first = definition.description.split(/(?<=[.!?])\s+/)[0]?.trim();
  return first || definition.name;
}

export function normalizeToolDefinition(definition: ToolDefinition): ToolDefinition {
  const name = canonicalToolName(definition.name);
  const inferredRoles: Array<'root' | 'child'> = CHILD_ONLY.has(name)
    ? ['child']
    : ROOT_ONLY.has(name)
      ? ['root']
      : ['root', 'child'];
  return {
    ...definition,
    name,
    inputSchema: normalizeToolSchema(definition.inputSchema ?? definition.parameters),
    catalog: {
      aliases: aliasesFor(name),
      keywords: keywordsFor(name),
      category: categoryFor(name),
      namespace: namespaceFor(name),
      exposure: exposureFor(name),
      roles: inferredRoles,
      effects: effectsFor(name, categoryFor(name)),
      summary: summaryFor(definition),
      ...definition.catalog,
    },
    policy: {
      idempotent: definition.idempotent,
      concurrency: 'serial',
      ...definition.policy,
    },
  };
}

function schemaTokens(definition: ToolDefinition): number {
  return estimateTokens(
    JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema ?? definition.parameters,
    }),
  );
}

function isRuntimeAvailable(definition: ToolDefinition, context: ToolContext): boolean {
  const name = canonicalToolName(definition.name);
  if (definition.catalog?.available && !definition.catalog.available(context)) return false;
  if (RUNTIME_CORE.has(name)) return Boolean(context.backgroundShells?.shells.size);
  if (name === 'EnterPlanMode') return context.currentMode !== 'plan';
  if (name === 'ExitPlanMode') return context.currentMode === 'plan';
  return true;
}

function isModeAvailable(definition: ToolDefinition, context: ToolContext): boolean {
  const name = canonicalToolName(definition.name);
  if (context.currentMode === 'dontAsk' && name === 'AskUserQuestion') return false;
  if (context.currentMode === 'plan' && !READ_ONLY_PLAN_TOOLS.has(name) && name !== 'ToolSearch') {
    return false;
  }
  return true;
}

function effectiveBudget(config: AgentConfig): number {
  const configured = config.settings.toolDiscovery.schemaTokenBudget;
  // Resolve through the shared window rather than skipping the cap when the model
  // declares nothing: leaving it uncapped inverted the incentive, so declaring
  // contextWindow: 32_000 shrank the catalog to 1600 while staying silent about the
  // same model kept the full budget.
  return Math.min(configured, Math.max(1000, Math.floor(resolveContextLimit(config) * 0.05)));
}

interface SurfaceOptions {
  config: AgentConfig;
  context: ToolContext;
  definitions: ToolDefinition[];
  capabilityRules?: string[];
  isSubagent?: boolean;
}

interface SearchRecord {
  definition: ToolDefinition;
  name: string;
  aliases: string;
  keywords: string;
  description: string;
  category: string;
  namespace: string;
}

export function createToolSurface(options: SurfaceOptions): ToolDiscoveryContext {
  const { config, context } = options;
  const sourceDefinitions = options.definitions.some(
    (definition) => definition.name === 'ToolSearch',
  )
    ? options.definitions
    : [...options.definitions, ...toolSearchTools];
  const definitions = sourceDefinitions.map(normalizeToolDefinition);
  const byName = new Map(
    definitions.map((definition) => [canonicalToolName(definition.name), definition]),
  );
  const ruleSets = new Map<number, CapabilityRule[]>();
  let nextRuleSetId = 1;
  if (options.capabilityRules) ruleSets.set(0, parseCapabilityRules(options.capabilityRules));
  const role = options.isSubagent ? 'child' : 'root';
  const state: ToolDiscoveryState = options.isSubagent
    ? { clock: 0, loaded: new Map() }
    : (context.runtime?.toolDiscoveryState ?? { clock: 0, loaded: new Map() });
  let activeSnapshot = new Set<string>();

  const authorized = (additionalRules?: CapabilityRule[]): ToolDefinition[] =>
    definitions.filter((definition) => {
      const name = canonicalToolName(definition.name);
      if (name === 'ToolSearch') return true;
      if (!definition.catalog?.roles?.includes(role)) return false;
      if ([...ruleSets.values()].some((rules) => !isToolDefinitionAllowed(rules, definition)))
        return false;
      if (additionalRules && !isToolDefinitionAllowed(additionalRules, definition)) return false;
      return isModeAvailable(definition, context) && isRuntimeAvailable(definition, context);
    });

  const deferredMode = (): boolean => {
    const available = authorized();
    const settings = config.settings.toolDiscovery;
    if (settings.mode === 'eager') return false;
    if (settings.mode === 'deferred') return true;
    const withoutSearch = available.filter((definition) => definition.name !== 'ToolSearch');
    return (
      withoutSearch.length > settings.eagerToolCount ||
      withoutSearch.reduce((total, definition) => total + schemaTokens(definition), 0) >
        effectiveBudget(config)
    );
  };

  const isCore = (definition: ToolDefinition): boolean => {
    const name = canonicalToolName(definition.name);
    if (name === 'ToolSearch') return deferredMode();
    if (name === 'EnterPlanMode' || name === 'ExitPlanMode')
      return isRuntimeAvailable(definition, context);
    if (MANAGED_TASK_CORE.has(name) && config.settings.agents.mode === 'off') return false;
    if (MUTATION_CORE.has(name) && context.currentMode === 'plan') return false;
    return definition.catalog?.exposure === 'core' || definition.catalog?.exposure === 'runtime';
  };

  const trimLoaded = (): void => {
    for (const name of state.loaded.keys()) {
      if (!byName.has(name)) state.loaded.delete(name);
    }
    const max = config.settings.toolDiscovery.maxLoadedTools;
    const ordered = [...state.loaded.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name] of ordered.slice(max)) state.loaded.delete(name);

    let total = 0;
    for (const [name] of ordered) {
      if (!state.loaded.has(name)) continue;
      const definition = byName.get(name);
      if (!definition) continue;
      const tokens = schemaTokens(definition);
      if (total + tokens > effectiveBudget(config)) state.loaded.delete(name);
      else total += tokens;
    }
  };

  const activeDefinitions = (): ToolDefinition[] => {
    trimLoaded();
    const available = authorized();
    const active = !deferredMode()
      ? available.filter((definition) => definition.name !== 'ToolSearch')
      : available.filter(
          (definition) =>
            isCore(definition) || state.loaded.has(canonicalToolName(definition.name)),
        );
    activeSnapshot = new Set(active.map((definition) => canonicalToolName(definition.name)));
    return active;
  };

  const search = (
    query: string,
    category?: ToolCategory,
    namespace?: string,
    limit = config.settings.toolDiscovery.searchLimit,
  ): ToolSearchMatch[] => {
    const active = new Set(
      activeDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    const records: SearchRecord[] = authorized()
      .filter((definition) => definition.name !== 'ToolSearch')
      .filter((definition) => !active.has(canonicalToolName(definition.name)))
      .filter((definition) => !category || definition.catalog?.category === category)
      .filter((definition) => !namespace || definition.catalog?.namespace === namespace)
      .map((definition) => ({
        definition,
        name: definition.name,
        aliases: definition.catalog?.aliases?.join(' ') ?? '',
        keywords: definition.catalog?.keywords?.join(' ') ?? '',
        description: definition.description,
        category: definition.catalog?.category ?? 'other',
        namespace: definition.catalog?.namespace ?? '',
      }));

    const fuse = new Fuse(records, {
      includeScore: true,
      threshold: 0.42,
      ignoreLocation: true,
      keys: [
        { name: 'name', weight: 4 },
        { name: 'aliases', weight: 3 },
        { name: 'keywords', weight: 2 },
        { name: 'description', weight: 1.5 },
        { name: 'category', weight: 1 },
        { name: 'namespace', weight: 1 },
      ],
    });
    const count = Math.max(1, Math.min(5, limit));
    const matches = query.trim()
      ? fuse.search(query, { limit: count }).map((result) => result.item)
      : records.slice(0, count);
    return matches.map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      summary: definition.catalog?.summary ?? summaryFor(definition),
      category: definition.catalog?.category ?? 'other',
      namespace: definition.catalog?.namespace,
      loaded: false,
    }));
  };

  const activate = (names: string[]): string[] => {
    const allowed = new Set(authorized().map((definition) => canonicalToolName(definition.name)));
    const requested = names.map(canonicalToolName);
    const budget = effectiveBudget(config);
    for (const name of [...requested].reverse()) {
      const definition = byName.get(name);
      if (
        allowed.has(name) &&
        name !== 'ToolSearch' &&
        definition &&
        schemaTokens(definition) <= budget
      ) {
        state.loaded.set(name, ++state.clock);
      }
    }
    trimLoaded();
    return requested.filter(
      (name, index) => requested.indexOf(name) === index && state.loaded.has(name),
    );
  };

  const pushRestriction = (rawRules: string[]): (() => void) => {
    const id = nextRuleSetId++;
    ruleSets.set(id, parseCapabilityRules(rawRules));
    trimLoaded();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ruleSets.delete(id);
      trimLoaded();
    };
  };

  const previewRestriction = (rawRules: string[]): ToolDefinition[] =>
    authorized(parseCapabilityRules(rawRules));

  const restrict = (rawRules: string[]): void => {
    pushRestriction(rawRules);
  };

  const canExecute = (call: ToolCall): boolean => {
    const name = canonicalToolName(call.name);
    if (!activeSnapshot.has(name)) return false;
    if (![...ruleSets.values()].every((rules) => isToolCallAllowed(rules, call))) return false;
    if (state.loaded.has(name)) state.loaded.set(name, ++state.clock);
    return true;
  };

  const catalogSummary = (): string => {
    if (!deferredMode()) return '';
    const active = new Set(
      activeDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    const deferred = authorized().filter(
      (definition) =>
        definition.name !== 'ToolSearch' && !active.has(canonicalToolName(definition.name)),
    );
    if (deferred.length === 0) return '';
    const categories = new Map<string, number>();
    const namespaces = new Map<string, number>();
    for (const definition of deferred) {
      const category = definition.catalog?.category ?? 'other';
      categories.set(category, (categories.get(category) ?? 0) + 1);
      const namespace = definition.catalog?.namespace;
      if (namespace) namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
    }
    const categoryText = [...categories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');
    const namespaceText = namespaces.size
      ? ` MCP namespaces: ${[...namespaces.entries()].map(([name, count]) => `${name} (${count})`).join(', ')}.`
      : '';
    return `${deferred.length} authorized tools are deferred: ${categoryText}.${namespaceText} Call ToolSearch when the active tools do not cover the task.`;
  };

  return {
    search,
    activate,
    restrict,
    pushRestriction,
    previewRestriction,
    canExecute,
    activeDefinitions,
    catalogSummary,
  };
}
