/**
 * Real-provider benchmark for reference-aware conversation compaction.
 *
 * The smoke tier preserves the original low-cost factual-recall check. The
 * standard tier adds updates, conflicts, temporal reasoning, multi-hop
 * synthesis, and abstention. Every probe is paired: full-history control versus
 * compacted treatment, with optional no-history leakage checks.
 *
 * Usage:
 *   npm run eval:compact
 *   npm run eval:compact -- --suite standard
 *   npm run eval:compact -- --model 9router/qc/qwen3.7-max --repeat 3
 *   npm run eval:compact -- --models model-a,model-b --include-no-history
 *
 * Requires a reachable provider (BOOK_API_KEY / settings). Never part of CI.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import {
  estimateHistoryTokens,
  estimateProviderRequestTokens,
  runCompact,
} from '../src/agent/compact.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { createProvider, type Provider } from '../src/provider/index.js';
import { estimateUsageCost, PRICING_VERSION } from '../src/pricing.js';
import { createRegistry } from '../src/tools/registry.js';
import { SessionRuntime } from '../src/session/runtime.js';
import { createAgentRunContext } from '../src/types/runs.js';
import type { AgentConfig } from '../src/types/runtime.js';
import type {
  AgentLoopCallbacks,
  ProviderMessage,
  ProviderStreamEvent,
} from '../src/types/providers.js';
import type { Message, Usage } from '../src/types/messages.js';
import type { CompactResult, ConversationCheckpointV2 } from '../src/types/sessions.js';
import type { AgentTerminalOutcome } from '../src/types/terminal.js';

export type CompactEvalSuite = 'smoke' | 'standard';
export type ProbeCategory =
  | 'static-recall'
  | 'knowledge-update'
  | 'conflict-resolution'
  | 'temporal-reasoning'
  | 'multi-hop'
  | 'abstention';

type EvidencePosition = 'early' | 'middle' | 'late' | 'distributed' | 'absent';

export type ProbeExpectation =
  | { kind: 'contains-all'; terms: string[] }
  | { kind: 'contains-any'; terms: string[] }
  | { kind: 'exact'; values: string[] }
  | { kind: 'abstain'; markers: string[] };

export interface Probe {
  name: string;
  category: ProbeCategory;
  tier: CompactEvalSuite;
  evidencePosition: EvidencePosition;
  prompt: string;
  expectation: ProbeExpectation;
  evidenceMessageIds: string[];
}

export interface CompactEvalFixture {
  name: string;
  history: Message[];
  probes: Probe[];
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface MeterCall {
  estimatedPromptTokens: number;
  usage?: Usage;
  responseModel?: string;
}

interface Meter {
  calls: MeterCall[];
  usage: UsageTotals;
  costUsd: number | null;
  costStatus: 'known' | 'unknown';
}

export interface ProbeGrade {
  pass: boolean;
  answer: string;
  formatCompliant: boolean;
  missingTerms: string[];
}

export type ProbeFailureKind =
  | 'none'
  | 'wrong-answer'
  | 'invalid-format'
  | 'empty-output'
  | 'unexpected-tool-call'
  | 'runtime-error';

export interface ProbeRunResult extends ProbeGrade {
  semanticPass: boolean;
  failureKind: ProbeFailureKind;
  outputPreview: string;
  toolCalls: string[];
  errors: string[];
  terminalStatus?: AgentTerminalOutcome['status'];
  terminalReason?: AgentTerminalOutcome['reason'];
  usage: UsageTotals;
}

export interface ProbeResult {
  name: string;
  category: ProbeCategory;
  evidencePosition: EvidencePosition;
  evidenceMessageIds: string[];
  control: ProbeRunResult;
  treatment: ProbeRunResult;
  noHistory?: ProbeRunResult;
}

export interface CompactEvalRunResult {
  version: 2;
  model: string;
  repetition: number;
  suite: CompactEvalSuite;
  fixture: string;
  historyTokens: number;
  historyMessages: number;
  compact: {
    status: CompactResult['status'];
    preContextTokens?: number;
    postContextTokens?: number;
    compressionRatio?: number;
    summarizedCount?: number;
    retainedCount?: number;
    modelCalls?: number;
    strategy?: string;
    degraded?: boolean;
    usage: UsageTotals;
    estimatedPromptTokens: number;
    costUsd: number | null;
    outputCapTokens?: number;
    checkpointTokens?: number;
    checkpoint?: ConversationCheckpointV2;
    effort?: AgentConfig['effort'];
    model: string;
  };
  probes: ProbeResult[];
  control: Meter;
  treatment: Meter;
  noHistory?: Meter;
}

export interface CompactEvalBundle {
  version: 2;
  createdAt: string;
  options: {
    suite: CompactEvalSuite;
    contextWindow: number;
    repetitions: number;
    includeNoHistory: boolean;
    probeLimit?: number;
    checkpointTokens?: number;
    compactEffort?: AgentConfig['effort'];
    compactModel?: string;
  };
  runs: CompactEvalRunResult[];
}

export interface CompactEvalOptions {
  models: string[];
  suite: CompactEvalSuite;
  contextWindow: number;
  repetitions: number;
  includeNoHistory: boolean;
  probeLimit?: number;
  checkpointTokens?: number;
  compactEffort?: AgentConfig['effort'];
  compactModel?: string;
  json: boolean;
}

const EMPTY_USAGE: UsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(target: UsageTotals, usage: UsageTotals): void {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
}

function usageTotals(usage: Usage | null | undefined): UsageTotals {
  return usage
    ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      }
    : { ...EMPTY_USAGE };
}

function makeMessage(role: Message['role'], content: string, index: number): Message {
  return {
    id: `compact-eval-${index}`,
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp: index,
  };
}

export function buildCompactEvalFixture(): CompactEvalFixture {
  const history: Message[] = [];
  let index = 0;
  const addTurn = (user: string, assistant: string): { userId: string; assistantId: string } => {
    const userMessage = makeMessage('user', user, index++);
    const assistantMessage = makeMessage('assistant', assistant, index++);
    history.push(userMessage, assistantMessage);
    return { userId: userMessage.id, assistantId: assistantMessage.id };
  };

  const runtime = addTurn(
    'Record the project constraints for the handoff. The runtime must remain Node.js 20 or newer. Do not change the public query() function signature.',
    'Recorded constraints: runtime is Node.js 20 or newer; the public query() function signature must remain unchanged.',
  );
  const cache = addTurn(
    'The accepted cache key is workspaceHash:modelId:v3. We rejected Redis because the benchmark must work offline and without a service dependency.',
    'Accepted decision: use workspaceHash:modelId:v3. Rejected decision: Redis, because offline execution is required.',
  );
  const openThread = addTurn(
    'There is one unresolved issue from the last run: the Windows CRLF fixture still fails and must remain an open thread until verified.',
    'Open thread recorded: the Windows CRLF fixture still fails and needs verification.',
  );
  const oldRegion = addTurn(
    'Initial deployment note: the staging region is us-east-1. This value may change after the migration.',
    'The initial staging region is recorded as us-east-1, pending migration.',
  );
  const wrongPackageManager = addTurn(
    'For now, assume npm is the package manager until the maintainer confirms the repository convention.',
    'Temporary assumption recorded: npm, awaiting an authoritative maintainer correction.',
  );

  const filler =
    'We inspected an unrelated implementation detail and found no change required. Keep the discussion scoped to the handoff, preserve existing behavior, and report evidence before claiming completion. ';
  const addFiller = (turn: number): void => {
    addTurn(
      `Unrelated investigation ${turn}: ${filler.repeat(3)}The result was informational only.`,
      `Investigation ${turn} is complete. No constraint, accepted decision, current value, or open thread changed. ${filler.repeat(3)}`,
    );
  };
  for (let turn = 1; turn <= 8; turn++) addFiller(turn);

  const currentRegion = addTurn(
    'Migration update: staging has moved successfully. The current deployment region is now eu-west-1; us-east-1 is historical only.',
    'Current state updated: staging region is eu-west-1. The earlier us-east-1 value is superseded.',
  );
  const packageCorrection = addTurn(
    'Maintainer correction: this repository requires pnpm 9. The earlier npm assumption was wrong and must not be used.',
    'Authoritative convention updated: use pnpm 9. The npm assumption is rejected.',
  );
  const mondayFailure = addTurn(
    'Monday verification event: the integration suite failed before the adapter patch was applied.',
    'Timeline recorded: integration failed on Monday.',
  );
  const tuesdayPatch = addTurn(
    'Tuesday verification event: the adapter patch was applied, but the suite was not run yet.',
    'Timeline recorded: adapter patch applied Tuesday; verification still pending.',
  );
  const apiUnits = addTurn(
    'Interface fact: the upstream API returns duration values in milliseconds.',
    'Recorded: upstream durations use milliseconds.',
  );

  for (let turn = 9; turn <= 16; turn++) addFiller(turn);

  const wednesdayPass = addTurn(
    'Wednesday verification event: the integration suite passed for the first time with the adapter patch.',
    'Timeline recorded: first passing integration run was Wednesday.',
  );
  const databaseUnits = addTurn(
    'Storage fact: the database persists duration values in whole seconds.',
    'Recorded: stored durations use seconds.',
  );
  const adapterRule = addTurn(
    'Implementation decision: the adapter converts API milliseconds to database seconds by dividing by 1000.',
    'Accepted conversion: milliseconds to seconds, divide by 1000 in the adapter.',
  );
  const thursdayRevert = addTurn(
    'Thursday verification event: the adapter patch was reverted after a separate regression. It is not active now.',
    'Current timeline state: the adapter patch was reverted Thursday and is no longer active.',
  );

  for (let turn = 17; turn <= 20; turn++) addFiller(turn);

  addTurn(
    'Continue the handoff from the established record. Summarize only new evidence from this latest inspection.',
    'The latest inspection found no new evidence and did not modify the established record.',
  );
  addTurn(
    'Before the next check, keep current values, accepted conventions, and unresolved verification items in view.',
    'Current values and unresolved verification state remain in view; no historical value became current again.',
  );

  const probes: Probe[] = [
    {
      name: 'runtime-constraint',
      category: 'static-recall',
      tier: 'smoke',
      evidencePosition: 'early',
      prompt:
        'Return JSON only as {"answer":"..."}. What minimum runtime version must this project continue to support? Quote the exact recorded value.',
      expectation: { kind: 'contains-all', terms: ['Node.js 20'] },
      evidenceMessageIds: [runtime.userId, runtime.assistantId],
    },
    {
      name: 'public-api-constraint',
      category: 'static-recall',
      tier: 'smoke',
      evidencePosition: 'early',
      prompt:
        'Return JSON only as {"answer":"..."}. What public API must not change? Quote the exact recorded constraint.',
      expectation: { kind: 'contains-all', terms: ['query() function signature'] },
      evidenceMessageIds: [runtime.userId, runtime.assistantId],
    },
    {
      name: 'accepted-decision',
      category: 'static-recall',
      tier: 'smoke',
      evidencePosition: 'early',
      prompt:
        'Return JSON only as {"answer":"..."}. What exact cache-key format was accepted? Do not invent a new format.',
      expectation: { kind: 'contains-all', terms: ['workspaceHash:modelId:v3'] },
      evidenceMessageIds: [cache.userId, cache.assistantId],
    },
    {
      name: 'rejected-decision',
      category: 'static-recall',
      tier: 'smoke',
      evidencePosition: 'early',
      prompt:
        'Return JSON only as {"answer":"..."}. Which proposed dependency was rejected, and why?',
      expectation: { kind: 'contains-all', terms: ['Redis', 'offline'] },
      evidenceMessageIds: [cache.userId, cache.assistantId],
    },
    {
      name: 'open-thread',
      category: 'static-recall',
      tier: 'smoke',
      evidencePosition: 'early',
      prompt:
        'Return JSON only as {"answer":"..."}. What verification issue is still open? Quote the specific fixture name.',
      expectation: { kind: 'contains-all', terms: ['Windows CRLF fixture', 'still fails'] },
      evidenceMessageIds: [openThread.userId, openThread.assistantId],
    },
    {
      name: 'current-region-update',
      category: 'knowledge-update',
      tier: 'standard',
      evidencePosition: 'distributed',
      prompt:
        'Return JSON only as {"answer":"..."}. What is the current staging deployment region? Return the current value, not the superseded historical value.',
      expectation: { kind: 'exact', values: ['eu-west-1'] },
      evidenceMessageIds: [oldRegion.userId, currentRegion.userId, currentRegion.assistantId],
    },
    {
      name: 'package-manager-correction',
      category: 'conflict-resolution',
      tier: 'standard',
      evidencePosition: 'distributed',
      prompt:
        'Return JSON only as {"answer":"..."}. Which package manager and major version does the maintainer require now?',
      expectation: { kind: 'contains-all', terms: ['pnpm', '9'] },
      evidenceMessageIds: [
        wrongPackageManager.userId,
        packageCorrection.userId,
        packageCorrection.assistantId,
      ],
    },
    {
      name: 'first-passing-day',
      category: 'temporal-reasoning',
      tier: 'standard',
      evidencePosition: 'distributed',
      prompt:
        'Return JSON only as {"answer":"..."}. On which day did the integration suite pass for the first time?',
      expectation: { kind: 'exact', values: ['Wednesday'] },
      evidenceMessageIds: [mondayFailure.userId, tuesdayPatch.userId, wednesdayPass.userId],
    },
    {
      name: 'current-patch-state',
      category: 'temporal-reasoning',
      tier: 'standard',
      evidencePosition: 'distributed',
      prompt:
        'Return JSON only as {"answer":"..."}. Is the adapter patch active now, and what latest event determines that state?',
      expectation: { kind: 'contains-all', terms: ['not active', 'reverted', 'Thursday'] },
      evidenceMessageIds: [tuesdayPatch.userId, wednesdayPass.userId, thursdayRevert.userId],
    },
    {
      name: 'unit-conversion-reasoning',
      category: 'multi-hop',
      tier: 'standard',
      evidencePosition: 'distributed',
      prompt:
        'Return JSON only as {"answer":"..."}. Why does the adapter divide duration values by 1000? Include the source and destination units.',
      expectation: { kind: 'contains-all', terms: ['milliseconds', 'seconds', '1000'] },
      evidenceMessageIds: [apiUnits.userId, databaseUnits.userId, adapterRule.userId],
    },
    {
      name: 'missing-secret-abstention',
      category: 'abstention',
      tier: 'standard',
      evidencePosition: 'absent',
      prompt:
        'Return JSON only as {"answer":"..."}. What is the staging database password? If the history does not contain it, say that it is unknown or not recorded.',
      expectation: {
        kind: 'abstain',
        markers: ['unknown', 'not recorded', 'not provided', 'not available', 'cannot determine'],
      },
      evidenceMessageIds: [],
    },
  ];
  return { name: 'handoff-state-and-history', history, probes };
}

function createMeter(): Meter {
  return { calls: [], usage: { ...EMPTY_USAGE }, costUsd: 0, costStatus: 'known' };
}

function createMeteredProvider(config: AgentConfig, meter: Meter): Provider {
  const base = createProvider(config);
  return {
    id: base.id,
    async *stream(
      currentConfig: AgentConfig,
      messages: ProviderMessage[],
      tools,
      options,
    ): AsyncGenerator<ProviderStreamEvent> {
      const call: MeterCall = {
        estimatedPromptTokens: estimateProviderRequestTokens(messages, tools),
      };
      meter.calls.push(call);
      for await (const event of base.stream(currentConfig, messages, tools, options)) {
        if (event.type === 'done' && event.usage) {
          call.usage = event.usage;
          call.responseModel = event.responseModel;
          addUsage(meter.usage, event.usage);
          const responseQuote = event.responseModel
            ? estimateUsageCost(event.responseModel, event.usage)
            : undefined;
          const quote =
            responseQuote?.status === 'known'
              ? responseQuote
              : estimateUsageCost(currentConfig.model, event.usage);
          if (quote.status === 'known' && meter.costUsd !== null) meter.costUsd += quote.costUsd;
          else {
            meter.costUsd = null;
            meter.costStatus = 'unknown';
          }
        }
        yield event;
      }
    },
  };
}

function normalizeAnswer(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function parseAnswer(text: string): { answer: string; formatCompliant: boolean } {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as { answer?: unknown; value?: unknown };
      const answer = parsed.answer ?? parsed.value;
      if (typeof answer === 'string') return { answer, formatCompliant: true };
    } catch {
      // Preserve the raw text for deterministic fallback scoring and diagnostics.
    }
  }
  return { answer: text, formatCompliant: false };
}

export function gradeProbe(text: string, expectation: ProbeExpectation): ProbeGrade {
  const parsed = parseAnswer(text);
  const answer = normalizeAnswer(parsed.answer);
  let missingTerms: string[] = [];
  let pass = false;
  if (expectation.kind === 'contains-all') {
    missingTerms = expectation.terms.filter((term) => !answer.includes(normalizeAnswer(term)));
    pass = missingTerms.length === 0;
  } else if (expectation.kind === 'contains-any') {
    pass = expectation.terms.some((term) => answer.includes(normalizeAnswer(term)));
    if (!pass) missingTerms = [...expectation.terms];
  } else if (expectation.kind === 'exact') {
    pass = expectation.values.some((value) => answer === normalizeAnswer(value));
    if (!pass) missingTerms = [...expectation.values];
  } else {
    pass = expectation.markers.some((marker) => answer.includes(normalizeAnswer(marker)));
    if (!pass) missingTerms = [...expectation.markers];
  }
  return {
    pass,
    answer: parsed.answer.trim(),
    formatCompliant: parsed.formatCompliant,
    missingTerms,
  };
}

/** Backward-compatible helper for exact-fact substring checks. */
export function scoreProbe(text: string, expected: string[]): boolean {
  return gradeProbe(text, { kind: 'contains-all', terms: expected }).pass;
}

function failureKindFor(options: {
  grade: ProbeGrade;
  output: string;
  toolCalls: string[];
  errors: string[];
  terminal?: AgentTerminalOutcome;
}): ProbeFailureKind {
  if (options.toolCalls.length > 0) return 'unexpected-tool-call';
  if (options.errors.length > 0 || (options.terminal && options.terminal.status !== 'completed')) {
    return 'runtime-error';
  }
  if (!options.output.trim()) return 'empty-output';
  if (!options.grade.pass) return 'wrong-answer';
  if (!options.grade.formatCompliant) return 'invalid-format';
  return 'none';
}

async function runProbe(
  config: AgentConfig,
  history: Message[],
  probe: Probe,
  provider: Provider,
): Promise<ProbeRunResult> {
  let output = '';
  const toolCalls: string[] = [];
  const errors: string[] = [];
  let terminal: AgentTerminalOutcome | undefined;
  const callbacks: AgentLoopCallbacks = {
    onText: (text) => {
      output += text;
    },
    onToolCall: (call) => toolCalls.push(call.name),
    onToolResult: () => {},
    onError: (error) => errors.push(error),
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (outcome) => {
      terminal = outcome;
    },
    onPermissionRequired: async () => 'deny',
  };
  const runtime = new SessionRuntime();
  const runContext = createAgentRunContext({ sessionId: crypto.randomUUID(), source: 'headless' });
  await runAgentLoop(
    config,
    createRegistry(),
    probe.prompt,
    history,
    callbacks,
    'bypassPermissions',
    {
      manageSessionHooks: false,
      isNewSession: true,
      runtime,
      runContext,
      provider,
    },
  );
  const grade = gradeProbe(output, probe.expectation);
  const failureKind = failureKindFor({ grade, output, toolCalls, errors, terminal });
  return {
    ...grade,
    semanticPass: grade.pass,
    pass: grade.pass && failureKind === 'none',
    failureKind,
    outputPreview: output.replace(/\s+/g, ' ').trim().slice(0, 240),
    toolCalls,
    errors,
    terminalStatus: terminal?.status,
    terminalReason: terminal?.reason,
    usage: usageTotals(runtime.runAccounting.snapshotRun(runContext.runId)?.directUsage),
  };
}

function withBenchmarkConfig(config: AgentConfig, contextWindow: number): AgentConfig {
  return {
    ...config,
    autoCompactEnabled: false,
    maxTurns: 1,
    maxTokens: 512,
    maxTokensExplicit: true,
    modelInfo: { ...config.modelInfo, contextWindow, maxOutputTokens: 512 },
  };
}

function selectProbes(
  fixture: CompactEvalFixture,
  suite: CompactEvalSuite,
  probeLimit?: number,
): Probe[] {
  const selected = fixture.probes.filter((probe) => suite === 'standard' || probe.tier === 'smoke');
  return probeLimit === undefined ? selected : selected.slice(0, probeLimit);
}

async function runFixture(options: {
  config: AgentConfig;
  compactConfig: AgentConfig;
  model: string;
  compactModel: string;
  repetition: number;
  fixture: CompactEvalFixture;
  suite: CompactEvalSuite;
  probeLimit?: number;
  includeNoHistory: boolean;
  checkpointTokens?: number;
  compactEffort?: AgentConfig['effort'];
}): Promise<CompactEvalRunResult> {
  const { config, compactConfig, fixture } = options;
  const control = createMeter();
  const treatment = createMeter();
  const noHistory = options.includeNoHistory ? createMeter() : undefined;
  const compactProvider = createMeteredProvider(compactConfig, treatment);
  const compact = await runCompact(compactConfig, fixture.history, {
    trigger: 'manual',
    provider: compactProvider,
    minMessages: 2,
    preContextTokens: estimateHistoryTokens(fixture.history),
    checkpointMaxTokens: options.checkpointTokens,
    effort: options.compactEffort,
  });
  const compactUsage = { ...treatment.usage };
  const compactCostUsd = treatment.costUsd;
  const compactEstimatedPromptTokens = treatment.calls.reduce(
    (sum, call) => sum + call.estimatedPromptTokens,
    0,
  );
  const treatmentHistory =
    compact.status === 'compacted' ? compact.replacementHistory : fixture.history;
  const probes: ProbeResult[] = [];
  for (const probe of selectProbes(fixture, options.suite, options.probeLimit)) {
    const controlResult = await runProbe(
      config,
      fixture.history,
      probe,
      createMeteredProvider(config, control),
    );
    const treatmentResult = await runProbe(
      config,
      treatmentHistory,
      probe,
      createMeteredProvider(config, treatment),
    );
    const noHistoryResult = noHistory
      ? await runProbe(config, [], probe, createMeteredProvider(config, noHistory))
      : undefined;
    probes.push({
      name: probe.name,
      category: probe.category,
      evidencePosition: probe.evidencePosition,
      evidenceMessageIds: probe.evidenceMessageIds,
      control: controlResult,
      treatment: treatmentResult,
      noHistory: noHistoryResult,
    });
  }
  const preContextTokens = compact.status === 'compacted' ? compact.preContextTokens : undefined;
  const postContextTokens = compact.status === 'compacted' ? compact.postContextTokens : undefined;
  return {
    version: 2,
    model: options.model,
    repetition: options.repetition,
    suite: options.suite,
    fixture: fixture.name,
    historyTokens: estimateHistoryTokens(fixture.history),
    historyMessages: fixture.history.length,
    compact: {
      status: compact.status,
      preContextTokens,
      postContextTokens,
      compressionRatio:
        preContextTokens && postContextTokens !== undefined
          ? postContextTokens / preContextTokens
          : undefined,
      summarizedCount: compact.status === 'compacted' ? compact.summarizedCount : undefined,
      retainedCount: compact.status === 'compacted' ? compact.retainedCount : undefined,
      modelCalls: compact.status === 'compacted' ? compact.modelCalls : undefined,
      strategy: compact.status === 'compacted' ? compact.strategy : undefined,
      degraded: compact.status === 'compacted' ? compact.degraded : undefined,
      usage: compactUsage,
      estimatedPromptTokens: compactEstimatedPromptTokens,
      costUsd: compactCostUsd,
      outputCapTokens: options.checkpointTokens,
      checkpointTokens:
        compact.status === 'compacted'
          ? estimateHistoryTokens([compact.replacementHistory[0]!])
          : undefined,
      checkpoint: compact.status === 'compacted' ? compact.checkpoint : undefined,
      effort: options.compactEffort,
      model: options.compactModel,
    },
    probes,
    control,
    treatment,
    noHistory,
  };
}

function pct(saved: number, baseline: number): number | null {
  return baseline > 0 ? (saved / baseline) * 100 : null;
}

export function breakEvenProbeCount(
  compactTokens: number,
  controlProbeTokens: number,
  treatmentProbeTokens: number,
  probeCount: number,
): number | null {
  if (probeCount <= 0) return null;
  const averageProbeSavings = (controlProbeTokens - treatmentProbeTokens) / probeCount;
  return averageProbeSavings > 0 ? Math.ceil(compactTokens / averageProbeSavings) : null;
}

function formatUsd(value: number | null): string {
  return value === null ? 'pricing unknown' : `$${value.toFixed(6)}`;
}

function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function passLabel(result: ProbeRunResult): string {
  return result.pass ? 'PASS' : `FAIL:${result.failureKind}`;
}

interface AggregateRow {
  name: string;
  runs: number;
  probes: number;
  controlPasses: number;
  treatmentPasses: number;
  retainedControlPasses: number;
  regressions: number;
  improvements: number;
  controlTokens: number;
  treatmentTokens: number;
  promptSavingsPct: number | null;
  netSavingsPct: number | null;
  breakEven: number | null;
  controlCostUsd: number | null;
  treatmentCostUsd: number | null;
  costSavingsPct: number | null;
  costBreakEven: number | null;
  compactTokensAverage: number;
  controlProtocolFailures: number;
  treatmentProtocolFailures: number;
  noHistoryPasses: number;
}

function sumKnownCosts(runs: CompactEvalRunResult[], meter: (run: CompactEvalRunResult) => Meter) {
  const costs = runs.map((run) => meter(run).costUsd);
  return costs.every((cost): cost is number => cost !== null)
    ? costs.reduce((sum, cost) => sum + cost, 0)
    : null;
}

function breakEvenCostCount(
  compactCostUsd: number | null,
  controlCostUsd: number | null,
  treatmentProbeCostUsd: number | null,
  probeCount: number,
): number | null {
  if (
    compactCostUsd === null ||
    controlCostUsd === null ||
    treatmentProbeCostUsd === null ||
    probeCount <= 0
  ) {
    return null;
  }
  const averageProbeSavings = (controlCostUsd - treatmentProbeCostUsd) / probeCount;
  return averageProbeSavings > 0 ? Math.ceil(compactCostUsd / averageProbeSavings) : null;
}

function aggregateRows(
  runs: CompactEvalRunResult[],
  key: (run: CompactEvalRunResult, probe?: ProbeResult) => string,
  byProbe: boolean,
): AggregateRow[] {
  const groups = new Map<string, { runs: Set<CompactEvalRunResult>; probes: ProbeResult[] }>();
  for (const run of runs) {
    if (byProbe) {
      for (const probe of run.probes) {
        const name = key(run, probe);
        const group = groups.get(name) ?? { runs: new Set(), probes: [] };
        group.runs.add(run);
        group.probes.push(probe);
        groups.set(name, group);
      }
    } else {
      const name = key(run);
      const group = groups.get(name) ?? { runs: new Set(), probes: [] };
      group.runs.add(run);
      group.probes.push(...run.probes);
      groups.set(name, group);
    }
  }
  return [...groups.entries()].map(([name, group]) => {
    const groupedRuns = [...group.runs];
    const controlTokens = groupedRuns.reduce((sum, run) => sum + run.control.usage.totalTokens, 0);
    const treatmentTokens = groupedRuns.reduce(
      (sum, run) => sum + run.treatment.usage.totalTokens,
      0,
    );
    const controlPromptTokens = groupedRuns.reduce(
      (sum, run) => sum + run.control.usage.promptTokens,
      0,
    );
    const treatmentProbePromptTokens = groupedRuns.reduce(
      (sum, run) => sum + run.treatment.usage.promptTokens - run.compact.usage.promptTokens,
      0,
    );
    const compactTokens = groupedRuns.reduce((sum, run) => sum + run.compact.usage.totalTokens, 0);
    const controlCostUsd = byProbe ? null : sumKnownCosts(groupedRuns, (run) => run.control);
    const treatmentCostUsd = byProbe ? null : sumKnownCosts(groupedRuns, (run) => run.treatment);
    const compactCosts = groupedRuns.map((run) => run.compact.costUsd);
    const compactCostUsd =
      !byProbe && compactCosts.every((cost): cost is number => cost !== null)
        ? compactCosts.reduce((sum, cost) => sum + cost, 0)
        : null;
    const treatmentProbeCostUsd =
      treatmentCostUsd !== null && compactCostUsd !== null
        ? treatmentCostUsd - compactCostUsd
        : null;
    const treatmentProbeTokens = group.probes.reduce(
      (sum, probe) => sum + probe.treatment.usage.totalTokens,
      0,
    );
    const controlProbeTokens = group.probes.reduce(
      (sum, probe) => sum + probe.control.usage.totalTokens,
      0,
    );
    return {
      name,
      runs: groupedRuns.length,
      probes: group.probes.length,
      controlPasses: group.probes.filter((probe) => probe.control.pass).length,
      treatmentPasses: group.probes.filter((probe) => probe.treatment.pass).length,
      retainedControlPasses: group.probes.filter(
        (probe) => probe.control.pass && probe.treatment.pass,
      ).length,
      regressions: group.probes.filter((probe) => probe.control.pass && !probe.treatment.pass)
        .length,
      improvements: group.probes.filter((probe) => !probe.control.pass && probe.treatment.pass)
        .length,
      controlTokens,
      treatmentTokens,
      promptSavingsPct: pct(controlPromptTokens - treatmentProbePromptTokens, controlPromptTokens),
      netSavingsPct: pct(controlTokens - treatmentTokens, controlTokens),
      breakEven: breakEvenProbeCount(
        compactTokens,
        controlProbeTokens,
        treatmentProbeTokens,
        group.probes.length,
      ),
      controlCostUsd,
      treatmentCostUsd,
      costSavingsPct:
        controlCostUsd !== null && treatmentCostUsd !== null
          ? pct(controlCostUsd - treatmentCostUsd, controlCostUsd)
          : null,
      costBreakEven: breakEvenCostCount(
        compactCostUsd,
        controlCostUsd,
        treatmentProbeCostUsd,
        group.probes.length,
      ),
      compactTokensAverage: groupedRuns.length > 0 ? compactTokens / groupedRuns.length : 0,
      controlProtocolFailures: group.probes.filter(
        (probe) =>
          probe.control.failureKind !== 'none' && probe.control.failureKind !== 'wrong-answer',
      ).length,
      treatmentProtocolFailures: group.probes.filter(
        (probe) =>
          probe.treatment.failureKind !== 'none' && probe.treatment.failureKind !== 'wrong-answer',
      ).length,
      noHistoryPasses: group.probes.filter((probe) => probe.noHistory?.pass).length,
    };
  });
}

export function renderBenchmarkReport(bundle: CompactEvalBundle): string {
  const modelRows = aggregateRows(bundle.runs, (run) => run.model, false);
  const categoryRows = aggregateRows(
    bundle.runs,
    (_run, probe) => probe?.category ?? 'unknown',
    true,
  );
  const lines = [
    '# Compact evaluation suite',
    '',
    `- Created: ${bundle.createdAt}`,
    `- Suite: ${bundle.options.suite}`,
    `- Context window: ${bundle.options.contextWindow.toLocaleString()}`,
    `- Repetitions: ${bundle.options.repetitions}`,
    `- No-history leakage arm: ${bundle.options.includeNoHistory ? 'enabled' : 'disabled'}`,
    `- Checkpoint output cap: ${bundle.options.checkpointTokens?.toLocaleString() ?? 'production default'}`,
    `- Compaction effort: ${bundle.options.compactEffort ?? 'production default'}`,
    `- Compaction model: ${bundle.options.compactModel ?? 'same as probe model'}`,
    `- Pricing table: ${PRICING_VERSION}`,
    '',
    '## Model Summary',
    '',
    '| Model | Accuracy full | Accuracy compact | Retention | Regressions | Improvements | Prompt savings | Net token savings | Net cost savings | Break-even tokens | Break-even cost | Avg compact tokens | Protocol full/compact |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...modelRows.map(
      (row) =>
        `| ${row.name} | ${row.controlPasses}/${row.probes} | ${row.treatmentPasses}/${row.probes} | ${row.retainedControlPasses}/${row.controlPasses || 0} | ${row.regressions} | ${row.improvements} | ${formatPct(row.promptSavingsPct)} | ${formatPct(row.netSavingsPct)} | ${formatPct(row.costSavingsPct)} | ${row.breakEven ?? 'n/a'} | ${row.costBreakEven ?? 'n/a'} | ${Math.round(row.compactTokensAverage).toLocaleString()} | ${row.controlProtocolFailures}/${row.treatmentProtocolFailures} |`,
    ),
    '',
    '## Category Summary',
    '',
    '| Category | Full | Compact | Retention | Regressions | Improvements | Protocol full/compact | No-history passes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...categoryRows.map(
      (row) =>
        `| ${row.name} | ${row.controlPasses}/${row.probes} | ${row.treatmentPasses}/${row.probes} | ${row.retainedControlPasses}/${row.controlPasses || 0} | ${row.regressions} | ${row.improvements} | ${row.controlProtocolFailures}/${row.treatmentProtocolFailures} | ${bundle.options.includeNoHistory ? `${row.noHistoryPasses}/${row.probes}` : '—'} |`,
    ),
    '',
    '## Run Details',
    '',
    '| Model | Reducer | Rep | Compact | Pre → post | Compression | Output cap | Checkpoint | Calls | Tokens | Cost |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...bundle.runs.map(
      (run) =>
        `| ${run.model} | ${run.compact.model} | ${run.repetition} | ${run.compact.status}${run.compact.degraded ? ' degraded' : ''} | ${(run.compact.preContextTokens ?? 0).toLocaleString()} → ${(run.compact.postContextTokens ?? 0).toLocaleString()} | ${run.compact.compressionRatio === undefined ? 'n/a' : `${(run.compact.compressionRatio * 100).toFixed(1)}%`} | ${run.compact.outputCapTokens?.toLocaleString() ?? 'default'} | ${run.compact.checkpointTokens?.toLocaleString() ?? 'n/a'} | ${run.compact.modelCalls ?? 0} | ${run.compact.usage.totalTokens.toLocaleString()} | ${formatUsd(run.compact.costUsd)} |`,
    ),
    '',
    '## Probe Diagnostics',
    '',
    '| Model | Rep | Probe | Category | Evidence | Full | Compact | No history |',
    '| --- | ---: | --- | --- | --- | --- | --- | --- |',
    ...bundle.runs.flatMap((run) =>
      run.probes.map(
        (probe) =>
          `| ${run.model} | ${run.repetition} | ${probe.name} | ${probe.category} | ${probe.evidencePosition} | ${passLabel(probe.control)} | ${passLabel(probe.treatment)} | ${probe.noHistory ? passLabel(probe.noHistory) : '—'} |`,
      ),
    ),
    '',
  ];
  return lines.join('\n');
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function parseEffort(value: string | undefined): AgentConfig['effort'] | undefined {
  return value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : undefined;
}

export function parseArgs(argv: string[]): CompactEvalOptions {
  const options: CompactEvalOptions = {
    models: [],
    suite: 'smoke',
    contextWindow: 24_000,
    repetitions: 1,
    includeNoHistory: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    if (argv[index] === '--model' && value) options.models.push(value);
    else if (argv[index] === '--models' && value) {
      options.models.push(
        ...value
          .split(',')
          .map((model) => model.trim())
          .filter(Boolean),
      );
    } else if (argv[index] === '--compact-model' && value) {
      options.compactModel = value;
    } else if (argv[index] === '--suite' && (value === 'smoke' || value === 'standard')) {
      options.suite = value;
    } else if (argv[index] === '--repeat') {
      options.repetitions = positiveInteger(value, options.repetitions, 1);
    } else if (argv[index] === '--probes') {
      options.probeLimit = positiveInteger(value, options.probeLimit ?? Number.MAX_SAFE_INTEGER, 1);
    } else if (argv[index] === '--context-window') {
      options.contextWindow = positiveInteger(value, options.contextWindow, 8_000);
    } else if (argv[index] === '--checkpoint-tokens') {
      options.checkpointTokens = positiveInteger(
        value,
        options.checkpointTokens ?? Number.MAX_SAFE_INTEGER,
        128,
      );
    } else if (argv[index] === '--compact-effort') {
      options.compactEffort = parseEffort(value) ?? options.compactEffort;
    } else if (argv[index] === '--include-no-history' || argv[index] === '--no-history') {
      options.includeNoHistory = true;
    } else if (argv[index] === '--json') options.json = true;
  }
  options.models = [...new Set(options.models)];
  return options;
}

function benchmarkFailed(bundle: CompactEvalBundle): boolean {
  return bundle.runs.some(
    (run) =>
      run.compact.status !== 'compacted' ||
      run.probes.some((probe) => probe.control.pass && !probe.treatment.pass),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workspace = await mkdtemp(join(tmpdir(), 'book-compact-eval-'));
  try {
    await mkdir(join(workspace, '.book'), { recursive: true });
    const requestedModels = options.models.length > 0 ? options.models : [undefined];
    const runs: CompactEvalRunResult[] = [];
    for (const requestedModel of requestedModels) {
      const loaded = loadConfig(workspace, {
        modelOverride: requestedModel,
        allowMissingApiKey: true,
      });
      const config = withBenchmarkConfig(loaded, options.contextWindow);
      const model = requestedModel ?? config.modelSelection ?? config.model;
      const compactLoaded = options.compactModel
        ? loadConfig(workspace, {
            modelOverride: options.compactModel,
            allowMissingApiKey: true,
          })
        : loaded;
      const compactConfig = withBenchmarkConfig(compactLoaded, options.contextWindow);
      const compactModel = options.compactModel ?? model;
      for (let repetition = 1; repetition <= options.repetitions; repetition++) {
        console.error(
          `compact-eval: ${model} repetition ${repetition}/${options.repetitions} (${options.suite})`,
        );
        runs.push(
          await runFixture({
            config,
            compactConfig,
            model,
            compactModel,
            repetition,
            fixture: buildCompactEvalFixture(),
            suite: options.suite,
            probeLimit: options.probeLimit,
            includeNoHistory: options.includeNoHistory,
            checkpointTokens: options.checkpointTokens,
            compactEffort: options.compactEffort,
          }),
        );
      }
    }
    const bundle: CompactEvalBundle = {
      version: 2,
      createdAt: new Date().toISOString(),
      options: {
        suite: options.suite,
        contextWindow: options.contextWindow,
        repetitions: options.repetitions,
        includeNoHistory: options.includeNoHistory,
        probeLimit: options.probeLimit,
        checkpointTokens: options.checkpointTokens,
        compactEffort: options.compactEffort,
        compactModel: options.compactModel,
      },
      runs,
    };
    const stamp = bundle.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const modelSlug =
      options.models.length === 1
        ? options.models[0]!.replace(/[^a-zA-Z0-9._-]+/g, '-')
        : options.models.length > 1
          ? `multi-${options.models.length}`
          : 'configured-default';
    const capSlug = options.checkpointTokens ? `-cap${options.checkpointTokens}` : '';
    const effortSlug = options.compactEffort ? `-effort${options.compactEffort}` : '';
    const reducerSlug = options.compactModel
      ? `-reducer${options.compactModel.replace(/[^a-zA-Z0-9._-]+/g, '-')}`
      : '';
    const base = `compact-eval-v2-${options.suite}-${modelSlug}${capSlug}${effortSlug}${reducerSlug}-${stamp}`;
    const reportDir = join(process.cwd(), '.book', 'reports');
    const markdown = renderBenchmarkReport(bundle);
    await mkdir(reportDir, { recursive: true });
    await writeFile(join(reportDir, `${base}.json`), JSON.stringify(bundle, null, 2), 'utf8');
    await writeFile(join(reportDir, `${base}.md`), markdown, 'utf8');
    if (options.json) console.log(JSON.stringify(bundle, null, 2));
    else console.log(`${markdown}\nReports: .book/reports/${base}.{json,md}`);
    if (benchmarkFailed(bundle)) process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('compact-eval.ts')) await main();
