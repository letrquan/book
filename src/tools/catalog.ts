import Fuse from 'fuse.js';
import type { Message } from '../types/messages.js';
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
  ToolRequest,
  ToolSearchMatch,
  ToolSelection,
} from '../types/tools.js';
import { estimateTokens } from '../context-report.js';
import { createDebugLogger } from '../debug-log.js';
import { resolveContextLimit } from '../models.js';
import { canonicalToolName, TOOL_ALIASES, unwrapProviderPrefix } from './aliases.js';
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

const log = createDebugLogger('tools:discovery');

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

/**
 * The catalog category of a canonical tool name. Exported because a name's
 * category is a capability fact the TUI reads (task bookkeeping is not a work
 * step), not just search metadata.
 */
export function categoryFor(name: string): ToolCategory {
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
    GitStatus: ['status', 'working tree', 'changes', 'modified', 'staged'],
    GitDiff: ['diff', 'changes', 'patch'],
    GitLog: ['log', 'history', 'commits'],
    GitCommit: ['commit', 'save changes'],
    GitBranch: ['branch', 'branches'],
    SessionHistorySearch: ['conversation', 'transcript', 'past session', 'history', 'earlier'],
    SessionHistoryRead: ['conversation', 'transcript', 'past session', 'history', 'earlier'],
    InvokeSkill: ['workflow', 'instructions'],
    Task: ['delegate', 'subagent', 'sub-agent', 'agent', 'parallel', 'spawn', 'worker'],
    AgentPlan: ['plan', 'delegation', 'budget', 'route'],
    AgentSpawn: [
      'delegate',
      'subagent',
      'sub-agent',
      'agent',
      'parallel',
      'spawn',
      'background',
      'worker',
    ],
    AgentList: ['agents', 'list', 'running', 'background'],
    AgentGet: ['status', 'agent', 'inspect'],
    AgentRead: ['subagent', 'result', 'output', 'continuation', 'summary'],
    AgentSend: ['follow-up', 'message', 'answer', 'resume', 'agent'],
    AgentWait: ['wait', 'finish', 'agent'],
    AgentStop: ['stop', 'cancel', 'agent'],
    AgentApply: ['apply', 'patch', 'candidate', 'validator'],
    EvidencePublish: ['evidence', 'publish', 'report'],
    EvidenceList: ['evidence', 'list', 'verified'],
    EvidenceReview: ['evidence', 'review', 'validator', 'verify'],
    Check: ['check', 'test', 'tests', 'lint', 'typecheck', 'build', 'verify'],
    NotebookEdit: ['jupyter', 'notebook', 'ipynb', 'cell'],
    DismissShell: ['shell', 'background', 'dismiss'],
    TaskStop: ['task', 'stop', 'cancel'],
    WebSearch: ['search', 'web', 'internet', 'research', 'online', 'lookup'],
    WebFetch: ['fetch', 'url', 'page', 'http', 'https', 'download', 'website', 'link'],
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

const HINT_WORDS = 8;

/**
 * Eight words or fewer of a tool's summary, for the deferred-tool list: its first clause when that
 * is at least three words, else whole words of the first sentence; parentheticals dropped, no
 * trailing punctuation, and a `…` when the sentence was cut mid-clause.
 */
function hintFor(definition: ToolDefinition): string {
  // Parentheticals go first: cut at a word limit they would be left open, and they hold the
  // detail (`(last 20, oneline)`) a hint can do without.
  const summary = (definition.catalog?.summary ?? summaryFor(definition))
    .replace(/\s*\([^)]*\)?/g, '')
    .trim();
  const clause = summary.split(/[,;\u2014]|:\s|\s-\s/)[0] ?? summary;
  const text = clause.split(/\s+/).filter(Boolean).length >= 3 ? clause : summary;
  const words = text.split(/\s+/).filter(Boolean);
  const hint = words
    .slice(0, HINT_WORDS)
    .join(' ')
    .replace(/[\s.,;:!-]+$/, '');
  if (!hint) return '';
  return words.length > HINT_WORDS ? `${hint}…` : hint;
}

/** More deferred tools than this in one MCP namespace are summarised as a count, not listed. */
const MCP_NAMESPACE_LIST_LIMIT = 12;

/** Code-point order: the same on every machine, unlike `localeCompare`, which follows the locale. */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

/**
 * Whether a rule or hook the user wrote targets ToolSearch itself: a `permissions.deny` or `ask`
 * rule on it, or a PreToolUse or PostToolUse hook whose matcher names it. Whoever wrote one meant
 * to gate or to audit the deferred catalog, so such a surface admits no direct call (#619): the
 * model loads deferred tools through ToolSearch as before, and the rule or hook sees that call. A hook with no matcher runs
 * on every call, the direct one included, so it gates nothing; an allow rule gates nothing either.
 * The tool is read as a permission rule (`parseRule`) and a hook matcher (`matchesHookMatcher`)
 * read it: the text before any `(`, trimmed, compared exactly, which is the only spelling either
 * matches ToolSearch with. It depends on settings alone, so it is decided once per surface.
 */
function toolSearchIsGated(config: AgentConfig): boolean {
  const namesToolSearch = (text: string): boolean => {
    const paren = text.indexOf('(');
    return (paren === -1 ? text : text.slice(0, paren)).trim() === 'ToolSearch';
  };
  const { permissions, hooks } = config.settings;
  return (
    [...(permissions?.deny ?? []), ...(permissions?.ask ?? [])].some(namesToolSearch) ||
    [...(hooks?.PreToolUse ?? []), ...(hooks?.PostToolUse ?? [])].some(
      (entry) => Boolean(entry.matcher) && namesToolSearch(entry.matcher!),
    )
  );
}

/**
 * The surface the agent loop builds its requests from: the shared discovery context, plus the one
 * call that starts a provider request.
 */
export interface ToolSurface extends ToolDiscoveryContext {
  /**
   * Build the next provider request's tools (#619), ending the previous request's direct
   * admissions as `activeDefinitions` does; a second build of the same request (after a compaction,
   * say) is just another call. `history` is the conversation the request carries. A reset point is
   * a newest compaction checkpoint the loaded set was not reset at, a different model, or a
   * smaller schema budget: there the loaded set drops what the model has already seen declared,
   * keeps what was loaded or called since it last answered (this turn's host activations, the last
   * tool round's `select:`) and, on a stable request, what the history still offers, and is
   * trimmed to the budgets oldest first. `stable` asks for the declaration a provider that keeps
   * `tools[]` fixed for the session sends.
   */
  prepareRequest(history: readonly Message[], options?: { stable?: boolean }): ToolRequest;
  /**
   * The provider answered the request built last: the tools it declared are ones the model has
   * seen. A request that failed is never marked, so a retry after a compaction keeps them.
   */
  markAnswered(): void;
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

/** Words that carry no capability in a ToolSearch query. */
const QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'any',
  'at',
  'by',
  'for',
  'from',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'need',
  'of',
  'on',
  'or',
  'please',
  'some',
  'the',
  'this',
  'that',
  'to',
  'tool',
  'tools',
  'use',
  'using',
  'want',
  'with',
]);

/**
 * Lowercase words of a name, keyword, or query. CamelCase and digits split (`WebFetch` → web,
 * fetch; `SpecialTool3` → special, tool, 3), so do `_`, `-`, spaces and punctuation; a chunk that
 * splits into more than one part also yields its joined lowercase form (`sub-agent` → sub, agent,
 * subagent; `GitLog` → git, log, gitlog), so a query spelled either way meets a keyword spelled
 * either way.
 */
function searchWords(text: string): string[] {
  const words: string[] = [];
  for (const chunk of text.split(/[^A-Za-z0-9_-]+/)) {
    if (!chunk) continue;
    const parts = chunk
      .split(/[_-]+/)
      .flatMap((part) =>
        part.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/),
      )
      .map((part) => part.toLowerCase())
      .filter(Boolean);
    words.push(...parts);
    const joined = chunk.toLowerCase().replace(/[_-]+/g, '');
    if (parts.length > 1 && !words.includes(joined)) words.push(joined);
  }
  return words;
}

/** The endings that make a longer word the same word as its stem, with nothing before the stem. */
const WORD_SUFFIXES = ['s', 'es', 'd', 'ed', 'ing', 'er', 'ers'] as const;

/**
 * The single edit that turns one word into the other, or undefined when they are further apart:
 * `'substitution'` for a swapped letter, `'other'` for a letter inserted, dropped or two adjacent
 * letters transposed. Callers pass the shorter word first, and need the distinction: one
 * substitution among five letters is often two different words, the same edit among six is a typo.
 */
function oneEditApart(short: string, long: string): 'substitution' | 'other' | undefined {
  if (long.length - short.length > 1) return undefined;
  if (short.length === long.length) {
    const differ: number[] = [];
    for (let index = 0; index < short.length; index++) {
      if (short[index] !== long[index]) differ.push(index);
      if (differ.length > 2) return undefined;
    }
    if (differ.length === 1) return 'substitution';
    // An adjacent transposition: `commti` for `commit`.
    if (
      differ.length === 2 &&
      differ[1] === differ[0] + 1 &&
      short[differ[0]] === long[differ[1]] &&
      short[differ[1]] === long[differ[0]]
    )
      return 'other';
    return undefined;
  }
  let index = 0;
  while (index < short.length && short[index] === long[index]) index++;
  return short.slice(index) === long.slice(index + 1) ? 'other' : undefined;
}

/**
 * True when a query token names the same word: equal, a suffix form of it (`logs` for `log`,
 * `searches` for `search`, `fetching` for `fetch`), or one typo. A prefix is not a form:
 * `checkout` is not `check` any more than it is `out`, and matching it put `Check` first for
 * "git checkout". A typo counts from five letters, and a substituted letter only from six: one
 * substitution between five-letter words is too often a different word (`match`/`patch`,
 * `texts`/`tests`), while an inserted, dropped or transposed letter is a typo from five (`comit`,
 * `commti`).
 */
function sameWord(token: string, word: string): boolean {
  if (token === word) return true;
  const [short, long] = token.length <= word.length ? [token, word] : [word, token];
  if (short.length >= 3 && WORD_SUFFIXES.some((suffix) => long === `${short}${suffix}`))
    return true;
  if (token.length < 5 || word.length < 5) return false;
  const edit = oneEditApart(short, long);
  return edit === 'other' ? true : edit === 'substitution' && short.length >= 6;
}

const SEARCH_FIELD_WEIGHTS = {
  name: 4,
  alias: 3,
  keyword: 2,
  namespace: 2,
  description: 1,
  category: 1,
} as const;

export function createToolSurface(options: SurfaceOptions): ToolSurface {
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
  const directCallsGated = toolSearchIsGated(config);
  // The tools a direct call admitted just in time this request (#619), with whether the budget let
  // their schema load. Separate from the snapshot, which a search rebuilds mid-request: an
  // admission lasts until the loop builds the next request's definitions.
  const admitted = new Map<string, boolean>();
  // What the request the model is answering declared to the provider: a tool outside it was called
  // without its schema, loaded since or not.
  let declared = new Set<string>();
  // A definition's word lists are fixed once normalized, and every search ranks the whole
  // catalog, so they are built on the first ranking and read from here after.
  const wordsByDefinition = new WeakMap<ToolDefinition, Array<[number, string[]]>>();
  // So is its schema's size, which the budget checks and `deferredMode` read on every admission
  // and every request: estimating it serializes the whole schema.
  const tokensByDefinition = new WeakMap<ToolDefinition, number>();
  const tokensOf = (definition: ToolDefinition): number => {
    let tokens = tokensByDefinition.get(definition);
    if (tokens === undefined) {
      tokens = schemaTokens(definition);
      tokensByDefinition.set(definition, tokens);
    }
    return tokens;
  };

  const fieldsFor = (definition: ToolDefinition): Array<[number, string[]]> => {
    const cached = wordsByDefinition.get(definition);
    if (cached) return cached;
    const fields: Array<[number, string[]]> = [
      [SEARCH_FIELD_WEIGHTS.name, searchWords(definition.name)],
      [SEARCH_FIELD_WEIGHTS.alias, (definition.catalog?.aliases ?? []).flatMap(searchWords)],
      [SEARCH_FIELD_WEIGHTS.keyword, (definition.catalog?.keywords ?? []).flatMap(searchWords)],
      [SEARCH_FIELD_WEIGHTS.namespace, searchWords(definition.catalog?.namespace ?? '')],
      [SEARCH_FIELD_WEIGHTS.description, searchWords(definition.description)],
      [SEARCH_FIELD_WEIGHTS.category, [definition.catalog?.category ?? 'other']],
    ];
    wordsByDefinition.set(definition, fields);
    return fields;
  };

  /**
   * A tool the runtime offers only some of the time: `BashOutput` and `KillShell` while a background
   * shell exists, and any tool whose catalog says when it is available (Advisor, the session tools).
   */
  const runtimeGated = (definition: ToolDefinition): boolean =>
    RUNTIME_CORE.has(canonicalToolName(definition.name)) || Boolean(definition.catalog?.available);

  /**
   * Whether the surface admits a definition: its role, every capability rule set, the mode, and
   * what the runtime offers right now. `declaring` asks instead whether a request declares it
   * (#619), which skips the runtime's own check for a runtime-gated tool: it stays declared whether
   * or not the runtime offers it right now, so its coming and going never rewrites `tools[]`.
   * Declaring is not offering: a call still meets `isActive` and `canExecute`, which refuse a tool
   * the runtime does not offer as unavailable.
   */
  const admits = (
    definition: ToolDefinition,
    additionalRules?: CapabilityRule[],
    declaring = false,
  ): boolean => {
    const name = canonicalToolName(definition.name);
    if (name === 'ToolSearch') return true;
    if (!definition.catalog?.roles?.includes(role)) return false;
    if ([...ruleSets.values()].some((rules) => !isToolDefinitionAllowed(rules, definition)))
      return false;
    if (additionalRules && !isToolDefinitionAllowed(additionalRules, definition)) return false;
    if (!isModeAvailable(definition, context)) return false;
    return (declaring && runtimeGated(definition)) || isRuntimeAvailable(definition, context);
  };

  const authorized = (additionalRules?: CapabilityRule[]): ToolDefinition[] =>
    definitions.filter((definition) => admits(definition, additionalRules));

  /**
   * Whether tools are deferred, for an `authorized()` set the caller already has, if any. In `auto`
   * mode it is decided once and kept until a reset point (#619): a background shell, an advisor or
   * the session tools coming and going would otherwise flip it, and rewrite every request's tools.
   */
  const deferredMode = (available?: ToolDefinition[]): boolean => {
    const settings = config.settings.toolDiscovery;
    if (settings.mode === 'eager') return false;
    if (settings.mode === 'deferred') return true;
    if (state.deferredMode === undefined) {
      const withoutSearch = (available ?? authorized()).filter(
        (definition) => definition.name !== 'ToolSearch',
      );
      state.deferredMode =
        withoutSearch.length > settings.eagerToolCount ||
        withoutSearch.reduce((total, definition) => total + tokensOf(definition), 0) >
          effectiveBudget(config);
    }
    return state.deferredMode;
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

  /**
   * A tool every request carries in front while it is authorized: the core in deferred mode, or
   * everything in eager mode, less the runtime-gated tools, which are appended (or, on a stable
   * request, deferred) once the runtime first offers them. ToolSearch only while deferring.
   */
  const isFixed = (definition: ToolDefinition, deferring: boolean): boolean =>
    deferring
      ? isCore(definition) && !runtimeGated(definition)
      : !runtimeGated(definition) && definition.name !== 'ToolSearch';

  const hostLoaded = (): Set<string> => (state.hostLoaded ??= new Set());

  /**
   * Drop loaded names this surface does not register. Nothing else is dropped mid-session (#619):
   * `load` admits a tool only while the budgets have room, so a loaded tool stays declared and the
   * request's tools only grow, until a reset point (`prepareRequest`) or `/clear`.
   */
  const trimLoaded = (): void => {
    for (const name of state.loaded.keys()) {
      if (byName.has(name)) continue;
      state.loaded.delete(name);
      hostLoaded().delete(name);
    }
  };

  /**
   * The tools callable now, refreshing the snapshot `isActive` reads: the fixed core in catalog
   * order, then the loaded tools the surface authorizes in the order they loaded, then a runtime
   * core tool the runtime offered since the request was built.
   */
  const currentDefinitions = (available = authorized()): ToolDefinition[] => {
    trimLoaded();
    let active: ToolDefinition[];
    if (!deferredMode(available)) {
      active = available.filter((definition) => definition.name !== 'ToolSearch');
    } else {
      const fixed = available.filter((definition) => isFixed(definition, true));
      const taken = new Set(fixed.map((definition) => canonicalToolName(definition.name)));
      const availableByName = new Map(
        available.map((definition) => [canonicalToolName(definition.name), definition]),
      );
      const loaded = [...state.loaded.keys()]
        .filter((name) => !taken.has(name))
        .map((name) => availableByName.get(name))
        .filter((definition): definition is ToolDefinition => definition !== undefined);
      for (const definition of loaded) taken.add(canonicalToolName(definition.name));
      const offeredSince = available.filter(
        (definition) => isCore(definition) && !taken.has(canonicalToolName(definition.name)),
      );
      active = [...fixed, ...loaded, ...offeredSince];
    }
    activeSnapshot = new Set(active.map((definition) => canonicalToolName(definition.name)));
    return active;
  };

  /** The definitions for the next provider request, which ends this request's admissions. */
  const activeDefinitions = (): ToolDefinition[] => {
    admitted.clear();
    const active = currentDefinitions();
    declared = new Set(active.map((definition) => canonicalToolName(definition.name)));
    return active;
  };

  /** The tools earlier replies recorded as offered by an addition (#619). */
  const offeredIn = (history: readonly Message[]): Set<string> => {
    const offered = new Set<string>();
    for (const message of history) {
      if (!message.includeInContext || message.role !== 'assistant') continue;
      for (const name of message.providerMetadata?.toolAdditions ?? []) offered.add(name);
    }
    return offered;
  };

  /** The loaded tools' count and schema tokens, which the budgets are checked against. */
  const loadedUsage = (allowed: ReadonlySet<string>): { count: number; tokens: number } => {
    // A loaded tool the surface does not authorize now (plan mode, a skill's restriction) holds no
    // slot while it is hidden, and the host's loads hold none at all.
    let count = 0;
    let tokens = 0;
    for (const name of state.loaded.keys()) {
      const definition = byName.get(name);
      if (!definition || !allowed.has(name) || hostLoaded().has(name)) continue;
      count++;
      tokens += tokensOf(definition);
    }
    return { count, tokens };
  };

  /** At a reset point, fit the loaded tools the budgets count back into them, oldest first. */
  const trimToBudget = (allowed: ReadonlySet<string>, budget: number): void => {
    const max = config.settings.toolDiscovery.maxLoadedTools;
    let { count, tokens } = loadedUsage(allowed);
    const oldestFirst = [...state.loaded.entries()]
      .filter(([name]) => allowed.has(name) && !hostLoaded().has(name) && byName.has(name))
      .sort((a, b) => a[1] - b[1]);
    for (const [name] of oldestFirst) {
      if (count <= max && tokens <= budget) break;
      state.loaded.delete(name);
      count--;
      tokens -= tokensOf(byName.get(name)!);
    }
  };

  /** A stable request's copy of a deferred tool, kept so every request sends the same object. */
  const deferredCopies = new WeakMap<ToolDefinition, ToolDefinition>();
  const deferredCopy = (definition: ToolDefinition): ToolDefinition => {
    let copy = deferredCopies.get(definition);
    if (!copy) {
      copy = { ...definition, deferLoading: true };
      deferredCopies.set(definition, copy);
    }
    return copy;
  };

  const markAnswered = (): void => {
    state.answeredAt = state.builtAt ?? 0;
  };

  const prepareRequest = (
    history: readonly Message[],
    requestOptions?: { stable?: boolean },
  ): ToolRequest => {
    const stable = requestOptions?.stable === true;
    let checkpoint: string | undefined;
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index]!;
      if (message.includeInContext && message.kind === 'checkpoint') {
        checkpoint = message.id;
        break;
      }
    }
    const budget = effectiveBudget(config);
    // A reset point: a compaction rebuilt the provider's cache, whichever host compacted, and a
    // different model shares no cache with this one; a smaller budget (a smaller window) is one
    // too. There the loaded set drops what the model has seen declared and keeps what was loaded
    // or called since its last answer, which it has not seen yet or just used.
    const reset =
      checkpoint !== state.resetAt ||
      (state.model !== undefined && state.model !== config.model) ||
      (state.budget !== undefined && budget < state.budget);
    state.resetAt = checkpoint;
    state.model = config.model;
    state.budget = budget;
    if (reset) {
      const answeredAt = state.answeredAt ?? 0;
      for (const [name, clock] of state.loaded) {
        if (clock > answeredAt) continue;
        state.loaded.delete(name);
        hostLoaded().delete(name);
      }
      state.deferredMode = undefined;
    }
    const available = authorized();
    const allowed = new Set(available.map((definition) => canonicalToolName(definition.name)));
    const deferring = deferredMode(available);
    if (reset) trimToBudget(allowed, budget);
    const offered = stable ? offeredIn(history) : new Set<string>();
    if (stable && deferring) {
      // What the history offers stays offered: the provider renders those additions again, so the
      // loaded set agrees with them after a reset point or a resume.
      for (const name of offered) {
        const definition = byName.get(name);
        if (
          definition &&
          allowed.has(name) &&
          !isFixed(definition, true) &&
          !runtimeGated(definition) &&
          !state.loaded.has(name)
        ) {
          state.loaded.set(name, ++state.clock);
        }
      }
    }
    // A runtime-gated tool the runtime offers loads as the host's once it first does, and stays
    // until a reset point: appended, or on a stable request offered by an addition, rather than
    // inserted into and taken out of the request's tools as it comes and goes.
    for (const definition of available) {
      const name = canonicalToolName(definition.name);
      if (!runtimeGated(definition) || state.loaded.has(name)) continue;
      if (deferring && !isCore(definition)) continue;
      state.loaded.set(name, ++state.clock);
      hostLoaded().add(name);
    }
    admitted.clear();
    currentDefinitions(available);
    state.builtAt = state.clock;

    const declarable = definitions.filter(
      (definition) =>
        admits(definition, undefined, true) && (deferring || definition.name !== 'ToolSearch'),
    );
    const fixed = declarable.filter((definition) => isFixed(definition, deferring));
    const fixedNames = new Set(fixed.map((definition) => canonicalToolName(definition.name)));
    if (!stable) {
      // Append-only: the fixed core, then every loaded tool still declarable, in load order. A
      // runtime tool the runtime stopped offering stays; execution refuses it as unavailable.
      const declarableNames = new Set(
        declarable.map((definition) => canonicalToolName(definition.name)),
      );
      const appended = [...state.loaded.keys()]
        .filter((name) => declarableNames.has(name) && !fixedNames.has(name))
        .map((name) => byName.get(name)!);
      const tools = [...fixed, ...appended];
      declared = new Set(tools.map((definition) => canonicalToolName(definition.name)));
      return { tools, shown: tools, additions: [] };
    }
    const deferredTools = declarable.filter((definition) => !isFixed(definition, deferring));
    const deferredNames = new Set(
      deferredTools.map((definition) => canonicalToolName(definition.name)),
    );
    const surfaced = [...state.loaded.keys()].filter((name) => deferredNames.has(name));
    // Offered once, after the request's last message; the reply records it, and the provider
    // sends it again in place on every later request. A runtime tool waits until it is offered.
    const additions = surfaced.filter((name) => !offered.has(name) && allowed.has(name));
    const shown = [
      ...fixed,
      ...surfaced
        .filter((name) => offered.has(name) || additions.includes(name))
        .map((name) => byName.get(name)!),
    ];
    declared = new Set(shown.map((definition) => canonicalToolName(definition.name)));
    return { tools: [...fixed, ...deferredTools.map(deferredCopy)], shown, additions };
  };

  const unloadedReason = (name: string): 'schema' | 'full' => {
    const definition = byName.get(canonicalToolName(name));
    return definition && tokensOf(definition) > effectiveBudget(config) ? 'schema' : 'full';
  };

  /**
   * Rank definitions against a query by its words, not the query as one fuzzy string: each query
   * word scores the heaviest field it names (tool name 4, alias 3, keyword 2, MCP namespace 2,
   * description 1, category 1), and a definition's score is the sum over the words. A tool
   * qualifies when a word names its name, an alias or a keyword, or when at least two words
   * appear in its description - description words alone are too common to admit a tool on
   * one hit, even a one-word query's (`not` takes the `es` suffix form of `notes`, which
   * would let every "do not" in a description answer a search for notes). Ties keep catalog
   * order.
   */
  const scoreByWords = (
    query: string,
    candidates: ToolDefinition[],
  ): Array<{ definition: ToolDefinition; score: number }> => {
    const tokens = [...new Set(searchWords(query))].filter((token) => !QUERY_STOPWORDS.has(token));
    if (tokens.length === 0) return [];
    const scored: Array<{ definition: ToolDefinition; score: number; index: number }> = [];
    candidates.forEach((definition, index) => {
      const fields = fieldsFor(definition);
      let score = 0;
      let strongHits = 0;
      let descriptionHits = 0;
      for (const token of tokens) {
        let best = 0;
        for (const [weight, words] of fields) {
          if (weight > best && words.some((word) => sameWord(token, word))) best = weight;
        }
        if (best >= SEARCH_FIELD_WEIGHTS.keyword) strongHits++;
        else if (best === SEARCH_FIELD_WEIGHTS.description) descriptionHits++;
        score += best;
      }
      const qualifies = strongHits > 0 || descriptionHits >= 2;
      if (qualifies && score > 0) scored.push({ definition, score, index });
    });
    return scored.sort((a, b) => b.score - a.score || a.index - b.index);
  };

  const rankByWords = (query: string, candidates: ToolDefinition[]): ToolDefinition[] =>
    scoreByWords(query, candidates).map((entry) => entry.definition);

  /**
   * The Fuse fallback for a query no word of which names anything, which is mostly a name whose
   * letters are all wrong (`Webfetch` spelled `Wibfetch`). The records it needs are built here
   * rather than for every search: ranking answers nearly every query on the definitions alone, and
   * indexing the whole catalog to throw it away costs every ToolSearch call.
   */
  const fuseFallback = (
    definitions: ToolDefinition[],
    query: string,
    count: number,
  ): ToolDefinition[] => {
    const records: SearchRecord[] = definitions.map((definition) => ({
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
    return fuse.search(query, { limit: count }).map((result) => result.item.definition);
  };

  const search = (
    query: string,
    category?: ToolCategory,
    namespace?: string,
    limit = config.settings.toolDiscovery.searchLimit,
  ): ToolSearchMatch[] => {
    const active = new Set(
      currentDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    const candidates = authorized()
      .filter((definition) => definition.name !== 'ToolSearch')
      .filter((definition) => !active.has(canonicalToolName(definition.name)))
      .filter((definition) => !category || definition.catalog?.category === category)
      .filter((definition) => !namespace || definition.catalog?.namespace === namespace);

    const count = Math.max(1, Math.min(5, limit));
    // A match scoring under half the best one is incidental, and loading it would hold a slot
    // nothing frees until the next compaction (#619): only the strong matches are loaded.
    const scored = query.trim() ? scoreByWords(query, candidates) : [];
    const best = scored[0]?.score ?? 0;
    const ranked = query.trim()
      ? scored.filter((entry) => entry.score * 2 >= best).map((entry) => entry.definition)
      : candidates;
    const matchedDefinitions =
      ranked.length > 0 || !query.trim()
        ? ranked.slice(0, count)
        : fuseFallback(candidates, query, count);
    return matchedDefinitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      summary: definition.catalog?.summary ?? summaryFor(definition),
      category: definition.catalog?.category ?? 'other',
      namespace: definition.catalog?.namespace,
      loaded: false,
    }));
  };

  /**
   * Names of the tools already active this turn that match a query, filtered exactly as `search`
   * filters its records: a category or namespace the call carried narrows the answer the same way
   * there, instead of naming tools the model excluded.
   */
  const activeMatches = (
    query: string,
    filter?: { category?: ToolCategory; namespace?: string; limit?: number },
  ): string[] =>
    rankByWords(
      query,
      currentDefinitions()
        .filter((definition) => definition.name !== 'ToolSearch')
        .filter(
          (definition) => !filter?.category || definition.catalog?.category === filter.category,
        )
        .filter(
          (definition) => !filter?.namespace || definition.catalog?.namespace === filter.namespace,
        ),
    )
      .slice(0, Math.max(1, Math.min(5, filter?.limit ?? 5)))
      .map((definition) => definition.name);

  /**
   * Load authorized tools for the next request, under the loaded-tool and schema budgets: the one
   * way in for a search, `select:`, a direct call, the intent router and the host alike. The reason
   * is only logged. Admission is append-only (#619): names are taken in the order given (a search's
   * rank order) while the budgets have room, a tool already loaded takes no new slot, and a tool
   * that does not fit is refused rather than evicting one the model has seen declared, which would
   * rewrite the request's tools. Every activation of a tool round lands in the next request
   * together. A tool the host needs (an active skill's resource reader) always loads, and takes no
   * slot.
   */
  const load = (
    names: string[],
    reason: 'search' | 'select' | 'direct' | 'route' | 'host',
    available = authorized(),
  ): string[] => {
    const allowed = new Set(available.map((definition) => canonicalToolName(definition.name)));
    const requested = [...new Set(names.map(canonicalToolName))];
    const budget = effectiveBudget(config);
    const max = config.settings.toolDiscovery.maxLoadedTools;
    trimLoaded();
    const usage = loadedUsage(allowed);
    const outsideBudgets: string[] = [];
    for (const name of requested) {
      const definition = byName.get(name);
      if (!allowed.has(name) || name === 'ToolSearch' || !definition) continue;
      if (state.loaded.has(name)) {
        state.loaded.set(name, ++state.clock);
        continue;
      }
      const tokens = tokensOf(definition);
      const fits = usage.count + 1 <= max && usage.tokens + tokens <= budget;
      if (reason === 'host') {
        hostLoaded().add(name);
        if (!fits) outsideBudgets.push(name);
      } else if (fits) {
        usage.count++;
        usage.tokens += tokens;
      } else {
        continue;
      }
      state.loaded.set(name, ++state.clock);
    }
    const loaded = requested.filter((name) => state.loaded.has(name));
    if (requested.length > 0) log.debug('tools activated', { reason, requested, loaded });
    if (outsideBudgets.length > 0) {
      log.debug('host tools loaded outside the discovery budgets', { names: outsideBudgets });
    }
    return loaded;
  };

  /**
   * `route` is the pre-turn intent router (#619), which asks for the user's text rather than for
   * the model, so it is opportunistic: it loads only authorized tools that are not active (a core
   * tool never takes a loaded slot) and that fit without evicting a tool the model loaded, and
   * none on a surface whose ToolSearch a rule or hook gates: there deferred tools load through
   * ToolSearch alone, where that rule or hook sees them, exactly as a direct call is refused.
   */
  const activate = (names: string[], reason: 'search' | 'host' | 'route' = 'host'): string[] => {
    if (reason !== 'route') return load(names, reason);
    if (directCallsGated) return [];
    const available = authorized();
    const allowed = new Set(available.map((definition) => canonicalToolName(definition.name)));
    const active = new Set(
      currentDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    // `load` admits what fits and evicts nothing, so the router needs no budget check of its own.
    const wanted = [...new Set(names.map(canonicalToolName))].filter(
      (name) => name !== 'ToolSearch' && allowed.has(name) && !active.has(name),
    );
    return load(wanted, reason, available);
  };

  /**
   * A tool's canonical name from a model-written one: exact first, then aliases, a provider prefix,
   * and letter case. A case-insensitive match must be unique; two tools that differ only by case
   * are `ambiguous` rather than resolved to whichever registered first.
   */
  const resolveName = (raw: string): { name?: string; ambiguous?: boolean } => {
    for (const written of new Set([raw, unwrapProviderPrefix(raw)])) {
      const name = canonicalToolName(written);
      if (byName.has(name)) return { name };
    }
    const lower = unwrapProviderPrefix(raw).toLowerCase();
    const found = new Set<string>();
    for (const candidate of byName.keys())
      if (candidate.toLowerCase() === lower) found.add(candidate);
    for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
      if (alias.toLowerCase() === lower && byName.has(target)) found.add(target);
    }
    return found.size === 1 ? { name: [...found][0] } : found.size > 1 ? { ambiguous: true } : {};
  };

  /**
   * Load exact tools by name (`select:A,B`), bypassing scoring. Authorization, roles, capability
   * rules and the loaded-tool and schema budgets are the same as for a search: `activate` is the
   * only way in.
   */
  const select = (names: string[]): ToolSelection[] => {
    const active = new Set(
      currentDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    const allowed = new Set(authorized().map((definition) => canonicalToolName(definition.name)));
    const outcomes: ToolSelection[] = [];
    const requested: string[] = [];
    for (const raw of names.map((name) => name.trim()).filter(Boolean)) {
      const { name, ambiguous } = resolveName(raw);
      if (ambiguous) outcomes.push({ requested: raw, status: 'ambiguous' });
      else if (!name) outcomes.push({ requested: raw, status: 'unknown' });
      else if (outcomes.some((outcome) => outcome.name === name)) continue;
      else if (!allowed.has(name)) outcomes.push({ requested: raw, name, status: 'unauthorized' });
      else if (name === 'ToolSearch') outcomes.push({ requested: raw, name, status: 'active' });
      else {
        outcomes.push({ requested: raw, name, status: active.has(name) ? 'active' : 'budget' });
        // A tool that is loaded is requested again so its recency is refreshed; it takes no new
        // slot, and nothing a call reports as callable is evicted to make room (#619).
        if (!active.has(name) || state.loaded.has(name)) requested.push(name);
      }
    }
    const loaded = new Set(load(requested, 'select'));
    const nowActive = new Set(
      currentDefinitions().map((definition) => canonicalToolName(definition.name)),
    );
    return outcomes.map((outcome) => {
      if (!outcome.name) return outcome;
      if (outcome.status === 'active')
        return nowActive.has(outcome.name) ? outcome : { ...outcome, status: 'budget' };
      if (outcome.status !== 'budget') return outcome;
      const definition = byName.get(outcome.name)!;
      return {
        ...outcome,
        status: loaded.has(outcome.name) ? 'loaded' : 'budget',
        category: definition.catalog?.category ?? 'other',
        namespace: definition.catalog?.namespace,
        summary: definition.catalog?.summary ?? summaryFor(definition),
      };
    });
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

  const isActive = (name: string): boolean => {
    const canonical = canonicalToolName(name);
    // ToolSearch is the way into the deferred catalog, so it is callable whenever the surface
    // has it (always: `authorized()` admits it unconditionally), even in eager mode where it is
    // left off the provider's tool list. Refusing it as `tool_not_active` told the model to
    // "call ToolSearch" about ToolSearch.
    return canonical === 'ToolSearch' || activeSnapshot.has(canonical) || admitted.has(canonical);
  };

  /**
   * Admit a direct call to an authorized tool that is not active (#619), doing what `select:` does
   * with the same `authorized()` set: load a deferred tool, then rebuild the snapshot. The call then
   * meets exactly the gates it would meet after `select:`. A core tool needs no loading: it is one
   * that became available after this request was built (a background shell started, an approved
   * plan restored the mode's mutating tools). A schema too large for the budget is still admitted
   * for this request, because the budget limits what the provider is sent, not what runs; it is
   * just not loaded.
   */
  const admitDirect = (name: string): { loaded: boolean } | undefined => {
    if (directCallsGated) return undefined;
    const canonical = canonicalToolName(name);
    const earlier = admitted.get(canonical);
    if (earlier !== undefined) return { loaded: earlier };
    if (isActive(canonical)) return undefined;
    const available = authorized();
    const definition = available.find(
      (candidate) => canonicalToolName(candidate.name) === canonical,
    );
    if (!definition) return undefined;
    const loaded =
      deferredMode(available) && !isCore(definition)
        ? load([canonical], 'direct', available).includes(canonical)
        : true;
    currentDefinitions();
    admitted.set(canonical, loaded);
    return { loaded };
  };

  /**
   * Why a registered tool is not active, for its refusal: outside the role or the capability rules
   * (`unauthorized`), outside what the mode or the runtime offers right now (`unavailable`), or
   * authorized and simply not loaded (`activatable`), which a surface that admits direct calls
   * admits instead of refusing.
   */
  const whyInactive = (name: string): 'unauthorized' | 'unavailable' | 'activatable' => {
    if (!isAuthorized(name)) return 'unauthorized';
    const canonical = canonicalToolName(name);
    return authorized().some((definition) => canonicalToolName(definition.name) === canonical)
      ? 'activatable'
      : 'unavailable';
  };

  const wasDeclared = (name: string): boolean => declared.has(canonicalToolName(name));

  /**
   * Whether the run admits the tool at all — its role and the capability rule sets —
   * ignoring activation and the mode. A name this rejects can never be
   * activated by a search this run, so the registry's refusal names the allowed tools instead
   * of pointing at ToolSearch.
   */
  const isAuthorized = (name: string): boolean => {
    const canonical = canonicalToolName(name);
    if (canonical === 'ToolSearch') return true;
    const definition = byName.get(canonical);
    if (!definition) return false;
    if (!definition.catalog?.roles?.includes(role)) return false;
    return [...ruleSets.values()].every((rules) => isToolDefinitionAllowed(rules, definition));
  };

  const canExecute = (call: ToolCall): boolean => {
    const name = canonicalToolName(call.name);
    if (!isActive(name)) return false;
    if (
      name !== 'ToolSearch' &&
      ![...ruleSets.values()].every((rules) =>
        // The session shell, exactly as the Bash tool and the permission gate read it, so a
        // single-quoted argument is judged one way everywhere (#512).
        isToolCallAllowed(rules, call, undefined, process.platform, context.shell ?? config.shell),
      )
    )
      return false;
    if (state.loaded.has(name)) state.loaded.set(name, ++state.clock);
    return true;
  };

  /**
   * The deferred tools the model can ask for, by canonical name. It lists every authorized tool
   * the core set leaves out, active or not, so loading and evicting a tool never changes the text
   * (it sits in the uncached suffix, but a stable list is one the model can rely on); it changes
   * only when authorization does: the mode, a role, or a capability rule set. MCP tools are
   * grouped by namespace and a namespace of more than `MCP_NAMESPACE_LIST_LIMIT` tools is a count.
   */
  const catalogSummary = (): string => {
    if (!deferredMode()) return '';
    const deferred = authorized()
      .filter((definition) => definition.name !== 'ToolSearch' && !isCore(definition))
      .sort((a, b) => compareCodePoints(a.name, b.name));
    if (deferred.length === 0) return '';
    const groups = new Map<string, ToolDefinition[]>();
    for (const definition of deferred) {
      const namespace = definition.catalog?.namespace;
      const key = namespace ? `mcp:${namespace}` : (definition.catalog?.category ?? 'other');
      groups.set(key, [...(groups.get(key) ?? []), definition]);
    }
    const lines = [...groups.entries()]
      .sort((a, b) => compareCodePoints(a[0], b[0]))
      .map(([key, members]) => {
        if (key.startsWith('mcp:') && members.length > MCP_NAMESPACE_LIST_LIMIT) {
          return `${key} (${members.length} tools, not listed): search them with ToolSearch: namespace "${key.slice(4)}" plus a query naming the capability.`;
        }
        const entries = members.map((definition) => {
          // An MCP server writes its own descriptions, and this text is system-prompt text: its
          // tools are listed by name only.
          const hint = key.startsWith('mcp:') ? '' : hintFor(definition);
          return hint ? `${definition.name} (${hint})` : definition.name;
        });
        return `${key}: ${entries.join('; ')}`;
      });
    // A surface whose ToolSearch a rule or hook gates offers no direct calls, so its text is the
    // one from before them.
    return [
      directCallsGated
        ? `${deferred.length} authorized tools are deferred: a tool's schema is loaded only once you select or search for it, and one already loaded is callable now. Load tools with ToolSearch: query "select:Name1,Name2" loads those exact tools (aliases and any letter case are accepted), and any other query searches by capability. Loaded tools are callable on the next turn.`
        : `${deferred.length} authorized tools are deferred: their schemas are not loaded yet, but you can call any tool listed here directly by name, and the call loads it. When you are unsure of a tool's arguments, load its schema first with ToolSearch: query "select:Name1,Name2" loads those exact tools (aliases and any letter case are accepted), and any other query searches by capability. A loaded tool's schema is declared from the next turn.`,
      ...lines,
      directCallsGated
        ? 'Call ToolSearch when the active tools do not cover the task.'
        : 'Call ToolSearch when neither the active tools nor this list cover the task.',
    ].join('\n');
  };

  return {
    search,
    activeMatches,
    activate,
    select,
    restrict,
    pushRestriction,
    previewRestriction,
    isActive,
    isAuthorized,
    admitDirect,
    unloadedReason,
    admitsDirectCalls: () => !directCallsGated,
    whyInactive,
    wasDeclared,
    canExecute,
    activeDefinitions,
    prepareRequest,
    markAnswered,
    catalogSummary,
  };
}
