/**
 * Experimental three-arm benchmark: full history, production compaction, and Zero-Mem retrieval.
 *
 * The compact and Zero-Mem arms share the same final-QA reader. Zero-Mem performs no LLM calls
 * during indexing or retrieval; its memory-operation token count is therefore zero by construction.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateHistoryTokens } from '../src/agent/compact.js';
import {
  calibrateZeroMemAnswer,
  type ZeroMemAnswerCalibration,
} from '../src/agent/zero-mem-answer.js';
import { createPaperZeroMemModel } from '../src/agent/zero-mem-models.js';
import {
  ZeroMemIndex,
  type ZeroMemOptions,
  type ZeroMemSemanticModel,
} from '../src/agent/zero-mem.js';
import { loadConfig } from '../src/config.js';
import type { Message } from '../src/types/messages.js';
import type { AgentConfig } from '../src/types/runtime.js';
import {
  buildCompactEvalFixture,
  COMPACT_EVAL_READER_MAX_TOKENS,
  createMeter,
  createMeteredProvider,
  runCompactEvaluationInProcess,
  runProbe,
  selectProbes,
  withBenchmarkConfig,
  type CompactEvalFixture,
  type CompactEvalOptions,
  type CompactEvalRunResult,
  type CompactEvalSuite,
  type Meter,
  type ProbeExpectation,
  type ProbeRunResult,
} from './compact-eval.js';

export interface ZeroMemEvalOptions {
  models: string[];
  suite: CompactEvalSuite;
  contextWindow: number;
  repetitions: number;
  probeLimit?: number;
  checkpointTokens?: number;
  compactEffort?: AgentConfig['effort'];
  compactModel?: string;
  topK: number;
  closureK: number;
  json: boolean;
  retrievalOnly?: boolean;
}

export interface ZeroMemProbeResult {
  name: string;
  category: string;
  evidenceMessageIds: string[];
  retrievedMessageIds: string[];
  evidenceHits: number;
  evidenceRecall: number | null;
  evidenceSufficient: boolean;
  contextTokens: number;
  contextBudgetTokens?: number;
  retrievalMs: number;
  calibration: ZeroMemAnswerCalibration;
  reader: ProbeRunResult;
}

export interface ZeroMemArmResult {
  indexMs: number;
  retrievalMs: number;
  memoryOperationTokens: 0;
  reader: Meter;
  probes: ZeroMemProbeResult[];
}

export interface ZeroMemEvalRun {
  model: string;
  repetition: number;
  compact: CompactEvalRunResult;
  zeroMem: ZeroMemArmResult;
}

export interface ZeroMemEvalBundle {
  version: 2;
  createdAt: string;
  options: ZeroMemEvalOptions;
  semanticModel: string;
  semanticModelLoadMs: number;
  runs: ZeroMemEvalRun[];
}

export interface ZeroMemRetrievalProbe {
  name: string;
  category: string;
  expectedMessageIds: string[];
  retrievedMessageIds: string[];
  evidenceHits: number;
  evidenceRecall: number | null;
  evidenceSufficient: boolean;
  contextTokens: number;
  retrievalMs: number;
}

export interface ZeroMemRetrievalBundle {
  version: 2;
  createdAt: string;
  options: ZeroMemEvalOptions;
  semanticModel: string;
  semanticModelLoadMs: number;
  historyTokens: number;
  historyMessages: number;
  indexMs: number;
  probes: ZeroMemRetrievalProbe[];
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

export function parseZeroMemEvalArgs(argv: string[]): ZeroMemEvalOptions {
  const options: ZeroMemEvalOptions = {
    models: [],
    suite: 'standard',
    contextWindow: 24_000,
    repetitions: 1,
    topK: 5,
    closureK: 3,
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
    } else if (argv[index] === '--compact-model' && value) options.compactModel = value;
    else if (argv[index] === '--suite' && (value === 'smoke' || value === 'standard')) {
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
    } else if (argv[index] === '--top-k') {
      options.topK = positiveInteger(value, options.topK, 1);
    } else if (argv[index] === '--closure-k') {
      options.closureK = positiveInteger(value, options.closureK, 0);
    } else if (argv[index] === '--retrieval-only' || argv[index] === '--offline') {
      options.retrievalOnly = true;
    } else if (argv[index] === '--json') options.json = true;
  }
  options.models = [...new Set(options.models)];
  return options;
}

function compactOptions(options: ZeroMemEvalOptions): CompactEvalOptions {
  return {
    models: options.models,
    suite: options.suite,
    contextWindow: options.contextWindow,
    repetitions: options.repetitions,
    includeNoHistory: false,
    probeLimit: options.probeLimit,
    checkpointTokens: options.checkpointTokens,
    compactEffort: options.compactEffort,
    compactModel: options.compactModel,
    json: false,
  };
}

function zeroMemOptions(
  options: ZeroMemEvalOptions,
  semanticModel: ZeroMemSemanticModel,
): ZeroMemOptions {
  return {
    semanticModel,
    topK: options.topK,
    closureK: options.closureK,
    gamma: 0.6,
    rho: 0.6,
  };
}

function evalMessage(
  id: string,
  content: string,
  timestamp: number,
  role: Message['role'],
): Message {
  return {
    id,
    role,
    content,
    includeInContext: true,
    kind: 'conversation',
    timestamp,
  };
}

export function buildZeroMemEvalFixture(): CompactEvalFixture {
  const fixture = buildCompactEvalFixture();
  fixture.name = `${fixture.name}-paper-alignment`;
  const currentRegionProbe = fixture.probes.find((probe) => probe.name === 'current-region-update');
  const currentRegionIds = fixture.history
    .filter((message) =>
      /current (?:deployment )?region is now eu-west-1|current state updated: staging region is eu-west-1/i.test(
        message.content,
      ),
    )
    .map((message) => message.id);
  if (currentRegionProbe && currentRegionIds.length > 0) {
    currentRegionProbe.evidenceMessageIds = currentRegionIds;
  }
  const packageProbe = fixture.probes.find((probe) => probe.name === 'package-manager-correction');
  const packageIds = fixture.history
    .filter((message) =>
      /^(?:Maintainer correction:|Authoritative convention updated:)/i.test(message.content),
    )
    .map((message) => message.id);
  if (packageProbe && packageIds.length > 0) packageProbe.evidenceMessageIds = packageIds;
  const patchProbe = fixture.probes.find((probe) => probe.name === 'current-patch-state');
  const currentPatchIds = fixture.history
    .filter((message) =>
      /^(?:Thursday verification event:|Current timeline state:)/i.test(message.content),
    )
    .map((message) => message.id);
  if (patchProbe && currentPatchIds.length > 0) patchProbe.evidenceMessageIds = currentPatchIds;

  const nextTimestamp = Math.max(...fixture.history.map((message) => message.timestamp), 0) + 1;
  const semanticUser = evalMessage(
    'zero-mem-semantic-alias-user',
    'Vehicle inspection note: the automobile selected for launch was crimson.',
    nextTimestamp,
    'user',
  );
  const semanticAssistant = evalMessage(
    'zero-mem-semantic-alias-assistant',
    'Recorded observation: the selected automobile was crimson.',
    nextTimestamp + 1,
    'assistant',
  );
  fixture.history.push(semanticUser, semanticAssistant);
  fixture.probes.push({
    name: 'semantic-alias-recall',
    category: 'static-recall',
    tier: 'standard',
    evidencePosition: 'late',
    prompt: 'Return JSON only as {"answer":"..."}. What color was the car selected for launch?',
    expectation: { kind: 'exact', values: ['crimson'] },
    evidenceMessageIds: [semanticUser.id, semanticAssistant.id],
  });
  return fixture;
}

function semanticPass(result: ProbeRunResult): boolean {
  return result.semanticPass && result.errors.length === 0 && result.toolCalls.length === 0;
}

function evidenceSupportsExpectation(text: string, expectation: ProbeExpectation): boolean {
  const normalized = text.toLocaleLowerCase();
  if (expectation.kind === 'contains-all') {
    return expectation.terms.every((term) => normalized.includes(term.toLocaleLowerCase()));
  }
  if (expectation.kind === 'contains-all-any') {
    return expectation.groups.every((group) =>
      group.some((term) => normalized.includes(term.toLocaleLowerCase())),
    );
  }
  if (expectation.kind === 'contains-any') {
    return expectation.terms.some((term) => normalized.includes(term.toLocaleLowerCase()));
  }
  if (expectation.kind === 'exact') {
    return expectation.values.some((value) => normalized.includes(value.toLocaleLowerCase()));
  }
  return text.trim().length === 0;
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function exactSourceRecall(
  probes: Array<{ evidenceHits: number; evidenceMessageIds: string[] }>,
): number | null {
  const expected = probes.reduce((sum, probe) => sum + probe.evidenceMessageIds.length, 0);
  if (expected === 0) return null;
  const hits = probes.reduce((sum, probe) => sum + probe.evidenceHits, 0);
  return hits / expected;
}

function percentReduction(candidate: number, baseline: number): number | null {
  return baseline > 0 ? ((baseline - candidate) / baseline) * 100 : null;
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function formatAnswer(result: ProbeRunResult): string {
  const label = semanticPass(result) ? 'PASS' : 'FAIL';
  const preview = result.answer.replace(/\s+/g, ' ').replaceAll('|', '\\|').slice(0, 100);
  return `${label}: ${preview || '(empty)'}`;
}

export async function runZeroMemEvaluation(
  options: ZeroMemEvalOptions,
  semanticRuntime?: { model: ZeroMemSemanticModel; loadMs: number },
): Promise<ZeroMemEvalBundle> {
  const fixture = buildZeroMemEvalFixture();
  const compactBundle = await runCompactEvaluationInProcess(compactOptions(options), fixture);
  const loadedSemantic = semanticRuntime ?? (await createPaperZeroMemModel());
  const semanticModel = loadedSemantic.model;
  const semanticModelLoadMs = loadedSemantic.loadMs;
  const runs: ZeroMemEvalRun[] = [];
  for (const compact of compactBundle.runs) {
    const loaded = loadConfig(process.cwd(), {
      modelOverride: compact.model,
      allowMissingApiKey: true,
    });
    const config = withBenchmarkConfig(loaded, options.contextWindow);
    const index = await ZeroMemIndex.create(
      fixture.history,
      zeroMemOptions(options, semanticModel),
    );
    const reader = createMeter();
    const provider = createMeteredProvider(config, reader);
    const probes: ZeroMemProbeResult[] = [];
    let retrievalMs = 0;
    for (const probe of selectProbes(fixture, options.suite, options.probeLimit)) {
      const contextBudgetTokens = compact.compact.postContextTokens;
      const built = await index.buildHistory(probe.prompt, {
        maxContextTokens: contextBudgetTokens,
      });
      retrievalMs += built.result.stats.retrievalMs;
      let calibration: ZeroMemAnswerCalibration | undefined;
      const result = await runProbe(config, built.history, probe, provider, (rawOutput) => {
        calibration = calibrateZeroMemAnswer(
          rawOutput,
          probe.prompt,
          built.result.evidence,
          built.result.profile,
        );
        return calibration.output;
      });
      if (!calibration)
        throw new Error(`Zero-Mem answer calibration did not run for ${probe.name}.`);
      const expected = new Set(probe.evidenceMessageIds);
      const retrievedMessageIds = built.result.evidence.map((item) => item.message.id);
      const retrievedText = built.result.evidence.map((item) => item.text).join('\n');
      const evidenceHits = retrievedMessageIds.filter((id) => expected.has(id)).length;
      probes.push({
        name: probe.name,
        category: probe.category,
        evidenceMessageIds: probe.evidenceMessageIds,
        retrievedMessageIds,
        evidenceHits,
        evidenceRecall: expected.size > 0 ? evidenceHits / expected.size : null,
        evidenceSufficient: evidenceSupportsExpectation(retrievedText, probe.expectation),
        contextTokens: estimateHistoryTokens(built.history),
        contextBudgetTokens,
        retrievalMs: built.result.stats.retrievalMs,
        calibration,
        reader: result,
      });
    }
    runs.push({
      model: compact.model,
      repetition: compact.repetition,
      compact,
      zeroMem: {
        indexMs: index.indexMs,
        retrievalMs,
        memoryOperationTokens: 0,
        reader,
        probes,
      },
    });
  }
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    options,
    semanticModel: semanticModel.name,
    semanticModelLoadMs,
    runs,
  };
}

export async function runZeroMemRetrievalEvaluation(
  options: ZeroMemEvalOptions,
  semanticRuntime?: { model: ZeroMemSemanticModel; loadMs: number },
): Promise<ZeroMemRetrievalBundle> {
  const fixture = buildZeroMemEvalFixture();
  const loadedSemantic = semanticRuntime ?? (await createPaperZeroMemModel());
  const index = await ZeroMemIndex.create(
    fixture.history,
    zeroMemOptions(options, loadedSemantic.model),
  );
  const probes: ZeroMemRetrievalProbe[] = [];
  for (const probe of selectProbes(fixture, options.suite, options.probeLimit)) {
    const built = await index.buildHistory(probe.prompt);
    const result = built.result;
    const expected = new Set(probe.evidenceMessageIds);
    const retrievedMessageIds = result.evidence.map((item) => item.message.id);
    const retrievedText = result.evidence.map((item) => item.text).join('\n');
    const evidenceHits = retrievedMessageIds.filter((id) => expected.has(id)).length;
    probes.push({
      name: probe.name,
      category: probe.category,
      expectedMessageIds: probe.evidenceMessageIds,
      retrievedMessageIds,
      evidenceHits,
      evidenceRecall: expected.size > 0 ? evidenceHits / expected.size : null,
      evidenceSufficient: evidenceSupportsExpectation(retrievedText, probe.expectation),
      contextTokens: estimateHistoryTokens(built.history),
      retrievalMs: result.stats.retrievalMs,
    });
  }
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    options,
    semanticModel: loadedSemantic.model.name,
    semanticModelLoadMs: loadedSemantic.loadMs,
    historyTokens: estimateHistoryTokens(fixture.history),
    historyMessages: fixture.history.length,
    indexMs: index.indexMs,
    probes,
  };
}

export function renderZeroMemRetrievalReport(bundle: ZeroMemRetrievalBundle): string {
  const averageContext = average(bundle.probes.map((probe) => probe.contextTokens));
  const sourceRecall = exactSourceRecall(
    bundle.probes.map((probe) => ({
      evidenceHits: probe.evidenceHits,
      evidenceMessageIds: probe.expectedMessageIds,
    })),
  );
  const sufficient = bundle.probes.filter((probe) => probe.evidenceSufficient).length;
  const averageRetrieval = average(bundle.probes.map((probe) => probe.retrievalMs));
  const contextReduction = percentReduction(averageContext, bundle.historyTokens);
  const lines = [
    '# Zero-Mem retrieval-only evaluation',
    '',
    `- Created: ${bundle.createdAt}`,
    `- Suite: ${bundle.options.suite}`,
    `- History: ${bundle.historyMessages} messages / ${bundle.historyTokens.toLocaleString()} estimated tokens`,
    `- Semantic model: ${bundle.semanticModel}`,
    `- Semantic model load: ${bundle.semanticModelLoadMs.toLocaleString()} ms`,
    `- Retrieval budget: ${bundle.options.topK} total traces, with up to ${bundle.options.closureK} closure additions`,
    `- Index time: ${bundle.indexMs.toLocaleString()} ms`,
    `- Average retrieval time: ${averageRetrieval.toFixed(1)} ms/query`,
    '- Provider-backed reader comparison was not run because no API credentials are configured.',
    '- Full-history evidence recall is a reference upper bound, not an answer-quality score.',
    '',
    '## Retrieval Summary',
    '',
    '| Arm | Expectation coverage | Exact source-ID recall | Avg context tokens | Context reduction | Memory-operation LLM tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| Full history (reference) | ${bundle.probes.length}/${bundle.probes.length} | 100.0% | ${bundle.historyTokens.toLocaleString()} | 0.0% | n/a |`,
    `| Zero-Mem | ${sufficient}/${bundle.probes.length} | ${formatPercent(sourceRecall === null ? null : sourceRecall * 100)} | ${Math.round(averageContext).toLocaleString()} | ${formatPercent(contextReduction)} | 0 |`,
    '',
    '## Probe Diagnostics',
    '',
    '| Probe | Category | Coverage | ID hits | Expected | Retrieved | Context tokens | Retrieval |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...bundle.probes.map(
      (probe) =>
        `| ${probe.name} | ${probe.category} | ${probe.evidenceSufficient ? 'PASS' : 'FAIL'} | ${probe.evidenceHits} | ${probe.expectedMessageIds.length} | ${probe.retrievedMessageIds.length} | ${probe.contextTokens.toLocaleString()} | ${probe.retrievalMs.toLocaleString()} ms |`,
    ),
    '',
    'To run the answer-quality comparison after configuring a provider:',
    '',
    '```text',
    'npm run eval:zero-mem -- --suite standard --model <provider/model>',
    '```',
    '',
  ];
  return lines.join('\n');
}

export function renderZeroMemEvalReport(bundle: ZeroMemEvalBundle): string {
  const modelNames = [...new Set(bundle.runs.map((run) => run.model))];
  const summaryRows = modelNames.map((model) => {
    const runs = bundle.runs.filter((run) => run.model === model);
    const compactProbes = runs.flatMap((run) => run.compact.probes);
    const zeroProbes = runs.flatMap((run) => run.zeroMem.probes);
    const fullPasses = compactProbes.filter((probe) => semanticPass(probe.control)).length;
    const compactPasses = compactProbes.filter((probe) => semanticPass(probe.treatment)).length;
    const zeroPasses = zeroProbes.filter((probe) => semanticPass(probe.reader)).length;
    const probes = compactProbes.length;
    const compactContext = average(runs.map((run) => run.compact.compact.postContextTokens ?? 0));
    const zeroContext = average(zeroProbes.map((probe) => probe.contextTokens));
    const compactMemoryTokens = average(runs.map((run) => run.compact.compact.usage.totalTokens));
    const compactTime = average(runs.map((run) => run.compact.compact.timeMs ?? 0));
    const zeroTime = average(runs.map((run) => run.zeroMem.indexMs + run.zeroMem.retrievalMs));
    return {
      model,
      probes,
      fullPasses,
      compactPasses,
      zeroPasses,
      compactContext,
      zeroContext,
      compactMemoryTokens,
      compactTime,
      zeroTime,
      evidenceCoverage: zeroProbes.filter((probe) => probe.evidenceSufficient).length,
      evidenceRecall: exactSourceRecall(zeroProbes),
      calibrationChanges: zeroProbes.filter((probe) => probe.calibration.changed).length,
      fullReaderPrompt: average(compactProbes.map((probe) => probe.control.usage.promptTokens)),
      compactReaderPrompt: average(
        compactProbes.map((probe) => probe.treatment.usage.promptTokens),
      ),
      zeroReaderPrompt: average(zeroProbes.map((probe) => probe.reader.usage.promptTokens)),
    };
  });
  const lines = [
    '# Zero-Mem vs production compaction',
    '',
    `- Created: ${bundle.createdAt}`,
    `- Suite: ${bundle.options.suite}`,
    `- Repetitions: ${bundle.options.repetitions}`,
    `- Semantic model: ${bundle.semanticModel}`,
    `- Semantic model load: ${bundle.semanticModelLoadMs.toLocaleString()} ms`,
    `- Retrieval budget: ${bundle.options.topK} total traces, with up to ${bundle.options.closureK} closure additions`,
    `- Context window: ${bundle.options.contextWindow.toLocaleString()}`,
    `- Reader output cap: ${COMPACT_EVAL_READER_MAX_TOKENS.toLocaleString()} tokens`,
    '- Zero-Mem uses the production compacted context size as its per-run maximum evidence-token budget.',
    '- Accuracy uses semantic probe grading; evaluator-attribution eligibility is reported by the underlying compact bundle but is not used as the experimental score.',
    '',
    '## Summary',
    '',
    '| Model | Full | Compact | Zero-Mem | Compact context | Zero context | Context reduction | Compact memory tokens | Zero memory tokens | Compact memory time | Zero index + retrieval | Evidence coverage | ID recall | Calibrations |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaryRows.map(
      (row) =>
        `| ${row.model} | ${row.fullPasses}/${row.probes} | ${row.compactPasses}/${row.probes} | ${row.zeroPasses}/${row.probes} | ${Math.round(row.compactContext).toLocaleString()} | ${Math.round(row.zeroContext).toLocaleString()} | ${formatPercent(percentReduction(row.zeroContext, row.compactContext))} | ${Math.round(row.compactMemoryTokens).toLocaleString()} | 0 | ${Math.round(row.compactTime).toLocaleString()} ms | ${Math.round(row.zeroTime).toLocaleString()} ms | ${row.evidenceCoverage}/${row.probes} | ${formatPercent(row.evidenceRecall === null ? null : row.evidenceRecall * 100)} | ${row.calibrationChanges}/${row.probes} |`,
    ),
    '',
    '## Reader Prompt Cost',
    '',
    '| Model | Full prompt/query | Compact prompt/query | Zero prompt/query | Zero vs compact |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...summaryRows.map(
      (row) =>
        `| ${row.model} | ${Math.round(row.fullReaderPrompt).toLocaleString()} | ${Math.round(row.compactReaderPrompt).toLocaleString()} | ${Math.round(row.zeroReaderPrompt).toLocaleString()} | ${formatPercent(percentReduction(row.zeroReaderPrompt, row.compactReaderPrompt))} |`,
    ),
    '',
    '## Probe Diagnostics',
    '',
    '| Model | Rep | Probe | Full | Compact | Zero-Mem | Evidence | Context / budget | Calibration | Retrieval |',
    '| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: |',
    ...bundle.runs.flatMap((run) =>
      run.zeroMem.probes.map((probe) => {
        const compactProbe = run.compact.probes.find((candidate) => candidate.name === probe.name)!;
        const budget = probe.contextBudgetTokens?.toLocaleString() ?? 'n/a';
        return `| ${run.model} | ${run.repetition} | ${probe.name} | ${formatAnswer(compactProbe.control)} | ${formatAnswer(compactProbe.treatment)} | ${formatAnswer(probe.reader)} | ${probe.evidenceHits}/${probe.evidenceMessageIds.length || 0} | ${probe.contextTokens.toLocaleString()} / ${budget} | ${probe.calibration.reason}${probe.calibration.changed ? ' (changed)' : ''} | ${probe.retrievalMs.toLocaleString()} ms |`;
      }),
    ),
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseZeroMemEvalArgs(argv);
  if (options.retrievalOnly) {
    const semanticRuntime = await createPaperZeroMemModel();
    let bundle: ZeroMemRetrievalBundle;
    try {
      bundle = await runZeroMemRetrievalEvaluation(options, semanticRuntime);
    } finally {
      await semanticRuntime.dispose();
    }
    const stamp = bundle.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const reportDir = join(process.cwd(), '.book', 'reports');
    const markdown = renderZeroMemRetrievalReport(bundle);
    const base = `zero-mem-retrieval-v2-${options.suite}-${stamp}`;
    await mkdir(reportDir, { recursive: true });
    await Promise.all([
      writeFile(join(reportDir, `${base}.json`), JSON.stringify(bundle, null, 2), 'utf8'),
      writeFile(join(reportDir, `${base}.md`), markdown, 'utf8'),
    ]);
    if (options.json) console.log(JSON.stringify(bundle, null, 2));
    else console.log(`${markdown}\nReports: .book/reports/${base}.{json,md}`);
    return;
  }
  const configured = loadConfig(process.cwd(), {
    modelOverride: options.models[0],
    allowMissingApiKey: true,
  });
  const localProvider = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(
    configured.baseUrl,
  );
  if (!configured.apiKey && !localProvider) {
    console.error(
      'zero-mem-eval: no provider API key is configured; running retrieval-only evaluation instead.',
    );
    const fallback = { ...options, retrievalOnly: true };
    const semanticRuntime = await createPaperZeroMemModel();
    let bundle: ZeroMemRetrievalBundle;
    try {
      bundle = await runZeroMemRetrievalEvaluation(fallback, semanticRuntime);
    } finally {
      await semanticRuntime.dispose();
    }
    const stamp = bundle.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const reportDir = join(process.cwd(), '.book', 'reports');
    const markdown = renderZeroMemRetrievalReport(bundle);
    const base = `zero-mem-retrieval-v2-${options.suite}-${stamp}`;
    await mkdir(reportDir, { recursive: true });
    await Promise.all([
      writeFile(join(reportDir, `${base}.json`), JSON.stringify(bundle, null, 2), 'utf8'),
      writeFile(join(reportDir, `${base}.md`), markdown, 'utf8'),
    ]);
    if (options.json) console.log(JSON.stringify(bundle, null, 2));
    else console.log(`${markdown}\nReports: .book/reports/${base}.{json,md}`);
    return;
  }
  const semanticRuntime = await createPaperZeroMemModel();
  let bundle: ZeroMemEvalBundle;
  try {
    bundle = await runZeroMemEvaluation(options, semanticRuntime);
  } finally {
    await semanticRuntime.dispose();
  }
  const stamp = bundle.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const modelSlug =
    options.models.length === 1
      ? options.models[0]!.replace(/[^a-zA-Z0-9._-]+/g, '-')
      : options.models.length > 1
        ? `multi-${options.models.length}`
        : 'configured-default';
  const base = `zero-mem-eval-v2-${options.suite}-${modelSlug}-${stamp}`;
  const reportDir = join(process.cwd(), '.book', 'reports');
  const markdown = renderZeroMemEvalReport(bundle);
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(join(reportDir, `${base}.json`), JSON.stringify(bundle, null, 2), 'utf8'),
    writeFile(join(reportDir, `${base}.md`), markdown, 'utf8'),
  ]);
  if (options.json) console.log(JSON.stringify(bundle, null, 2));
  else console.log(`${markdown}\nReports: .book/reports/${base}.{json,md}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main();
  // Native model/router clients can retain idle handles after the report is flushed.
  process.exit(0);
}
