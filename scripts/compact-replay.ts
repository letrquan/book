/**
 * Replay real compactions against a real model.
 *
 * For every `compact` record in a sessions directory (default: the owner's
 * `<BOOK_HOME>/sessions`), load the session as it stood just before the record,
 * run `runCompact` on it, and ask the judge whether the new context holds what
 * the agent's next real steps relied on. The sessions directory is only read:
 * each case copies the session prefix it needs into a temp directory.
 *
 * Usage:
 *   npm run eval:compact-replay -- --since 2026-09-17 --per-model 4
 *   npm run eval:compact-replay -- --model 9router/cmc/stealth/space-bunny-alpha --limit 6
 *   npm run eval:compact-replay -- --sessions db7d16ed,b221dec7 --label v3
 *
 * By default each case replays on the model the session was using, routed
 * through `--provider` (default `9router`) when the recorded model id has no
 * provider prefix. `--label` names the report (e.g. `baseline`, `v3`).
 *
 * Requires a reachable provider. Never part of CI.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { resolveBookHome } from '../src/book-home.js';
import {
  applyCompactResult,
  judgeCompaction,
  resolveCompactBudgets,
  runCompact,
} from '../src/agent/compact.js';
import { SessionStore } from '../src/session/store.js';
import type { AgentConfig } from '../src/types/runtime.js';
import type { CompactJudgeVerdict, CompactResult } from '../src/types/sessions.js';
import type { Message, Usage } from '../src/types/messages.js';

interface Options {
  sessionsDir: string;
  since?: number;
  until?: number;
  limit?: number;
  perModel?: number;
  sessionPrefixes?: string[];
  model?: string;
  provider: string;
  concurrency: number;
  judgeSteps: number;
  overheadTokens: number;
  label: string;
  outDir: string;
  workspace: string;
}

interface ReplayCase {
  sessionId: string;
  file: string;
  /** Index of the compact record among the session's lines. */
  line: number;
  timestamp: number;
  originalModel: string;
  original: {
    trigger?: string;
    strategy?: string;
    degraded?: boolean;
    modelCalls?: number;
    preContextTokens?: number;
    postContextTokens?: number;
    retainedCount?: number;
    carriedCount?: number;
    generation?: number;
  };
}

interface CaseResult extends ReplayCase {
  replayModel: string;
  preMessages: number;
  status: CompactResult['status'];
  reason?: string;
  error?: string;
  strategy?: string;
  degraded?: boolean;
  coverageReasons?: string[];
  modelCalls?: number;
  generation?: number;
  preTokens?: number;
  postTokens?: number;
  retainedCount?: number;
  carriedCount?: number;
  summaryChars?: number;
  summaryIsJson?: boolean;
  wallMs: number;
  promptTokens: number;
  completionTokens: number;
  judge?: CompactJudgeVerdict;
  judgeSteps?: number;
}

interface RawRecord {
  type?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    sessionsDir: join(resolveBookHome(), 'sessions'),
    provider: '9router',
    concurrency: 3,
    judgeSteps: 6,
    overheadTokens: 12_000,
    label: 'replay',
    outDir: resolve('.book/reports'),
    workspace: process.cwd(),
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    const positive = (): number => {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error(`${flag} needs a positive integer`);
      return parsed;
    };
    if (flag === '--sessions-dir') options.sessionsDir = resolve(value());
    else if (flag === '--since') options.since = Date.parse(value());
    else if (flag === '--until') options.until = Date.parse(value());
    else if (flag === '--limit') options.limit = positive();
    else if (flag === '--per-model') options.perModel = positive();
    else if (flag === '--sessions') options.sessionPrefixes = value().split(',').filter(Boolean);
    else if (flag === '--model') options.model = value();
    else if (flag === '--provider') options.provider = value();
    else if (flag === '--concurrency') options.concurrency = positive();
    else if (flag === '--judge-steps') options.judgeSteps = positive();
    else if (flag === '--overhead') options.overheadTokens = positive();
    else if (flag === '--label') options.label = value();
    else if (flag === '--out') options.outDir = resolve(value());
    else if (flag === '--workspace') options.workspace = resolve(value());
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return options;
}

function readLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

function parseLine(line: string): RawRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as RawRecord;
  } catch {
    return undefined;
  }
}

/** Every compact record in the directory, oldest first, with the model the session was using. */
function discoverCases(options: Options): ReplayCase[] {
  const cases: ReplayCase[] = [];
  for (const name of readdirSync(options.sessionsDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (
      options.sessionPrefixes &&
      !options.sessionPrefixes.some((prefix) => sessionId.startsWith(prefix))
    ) {
      continue;
    }
    const file = join(options.sessionsDir, name);
    const lines = readLines(file);
    let lastModel = '';
    lines.forEach((line, index) => {
      const record = parseLine(line);
      if (!record) return;
      if (record.type === 'usage') {
        const model = record.data?.requestedModel;
        if (typeof model === 'string' && model) lastModel = model;
        return;
      }
      if (record.type !== 'compact') return;
      const timestamp = record.timestamp ?? 0;
      if (options.since !== undefined && timestamp < options.since) return;
      if (options.until !== undefined && timestamp >= options.until) return;
      const data = record.data ?? {};
      const checkpoint = data.checkpoint as { generation?: number } | undefined;
      cases.push({
        sessionId,
        file,
        line: index,
        timestamp,
        originalModel: lastModel || 'unknown',
        original: {
          trigger: data.trigger as string | undefined,
          strategy: data.strategy as string | undefined,
          degraded: data.degraded as boolean | undefined,
          modelCalls: data.modelCalls as number | undefined,
          preContextTokens: data.preContextTokens as number | undefined,
          postContextTokens: data.postContextTokens as number | undefined,
          retainedCount: data.retainedCount as number | undefined,
          carriedCount: data.carriedCount as number | undefined,
          generation: checkpoint?.generation,
        },
      });
    });
  }
  cases.sort((left, right) => left.timestamp - right.timestamp);
  let selected = cases;
  if (options.perModel) {
    const counts = new Map<string, number>();
    selected = [...cases].reverse().filter((item) => {
      const count = counts.get(item.originalModel) ?? 0;
      if (count >= options.perModel!) return false;
      counts.set(item.originalModel, count + 1);
      return true;
    });
    selected.reverse();
  }
  return options.limit ? selected.slice(-options.limit) : selected;
}

/** The session's context history after its first `lineCount` lines, loaded the way a resume loads it. */
function loadPrefix(item: ReplayCase, lineCount: number): Message[] {
  const root = mkdtempSync(join(tmpdir(), 'book-compact-replay-'));
  try {
    const lines = readLines(item.file).slice(0, lineCount);
    writeFileSync(join(root, `${item.sessionId}.jsonl`), `${lines.join('\n')}\n`);
    return new SessionStore(root).load(item.sessionId).contextHistory;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The next real steps after the compaction: messages appended to its replacement, before any later compaction. */
function loadRealSteps(item: ReplayCase, maxSteps: number): Message[] {
  const lines = readLines(item.file);
  const replacement = loadPrefix(item, item.line + 1);
  let end = item.line + 1;
  for (; end < lines.length; end++) {
    if (parseLine(lines[end])?.type === 'compact') break;
  }
  const after = loadPrefix(item, end);
  if (after.length <= replacement.length) return [];
  for (let index = 0; index < replacement.length; index++) {
    if (after[index].id !== replacement[index].id) return [];
  }
  return after
    .slice(replacement.length)
    .filter((message) => message.includeInContext && message.kind !== 'local')
    .slice(0, maxSteps);
}

function replayModelFor(item: ReplayCase, options: Options): string {
  if (options.model) return options.model;
  return item.originalModel.startsWith(`${options.provider}/`)
    ? item.originalModel
    : `${options.provider}/${item.originalModel}`;
}

function configFor(model: string, options: Options): AgentConfig {
  const config = loadConfig(options.workspace, { modelOverride: model });
  // The owner's PreCompact/PostCompact hooks must not run against replayed history.
  return {
    ...config,
    settings: {
      ...config.settings,
      hooks: { ...config.settings.hooks, PreCompact: [], PostCompact: [] },
    },
  };
}

async function runCase(item: ReplayCase, options: Options): Promise<CaseResult> {
  const replayModel = replayModelFor(item, options);
  const history = loadPrefix(item, item.line);
  const config = configFor(replayModel, options);
  const usage = { promptTokens: 0, completionTokens: 0 };
  const onUsage = (value: Usage): void => {
    usage.promptTokens += value.promptTokens ?? 0;
    usage.completionTokens += value.completionTokens ?? 0;
  };
  const base = {
    ...item,
    replayModel,
    preMessages: history.length,
  };
  const startedAt = Date.now();
  let result: CompactResult;
  try {
    result = await runCompact(config, history, {
      trigger: 'auto',
      preContextTokens: item.original.preContextTokens,
      requestOverheadTokens: options.overheadTokens,
      onUsage,
    });
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      wallMs: Date.now() - startedAt,
      ...usage,
    };
  }
  const wallMs = Date.now() - startedAt;
  if (result.status !== 'compacted') {
    return {
      ...base,
      status: result.status,
      reason: result.reason,
      ...(result.status === 'failed' ? { error: result.error } : {}),
      wallMs,
      ...usage,
    };
  }
  const summary = result.checkpoint.state.summary;
  const outcome: CaseResult = {
    ...base,
    status: 'compacted',
    strategy: result.strategy,
    degraded: result.degraded,
    coverageReasons: result.checkpoint.coverage?.reasons,
    modelCalls: result.modelCalls,
    generation: result.generation,
    preTokens: result.preContextTokens,
    postTokens: result.postContextTokens,
    retainedCount: result.retainedCount,
    carriedCount: result.carriedCount,
    summaryChars: summary.length,
    summaryIsJson: summary.trimStart().startsWith('{'),
    wallMs,
    ...usage,
  };
  const steps = loadRealSteps(item, options.judgeSteps);
  if (steps.length === 0) return outcome;
  const applied = applyCompactResult(result, history, [...history, ...steps], {
    toolResultMaxTokens: resolveCompactBudgets(config).retainedToolResultMaxTokens,
  });
  if (!applied) return outcome;
  try {
    const judge = await judgeCompaction(config, applied, steps, { onUsage });
    return { ...outcome, judge, judgeSteps: steps.length, ...usage };
  } catch (error) {
    return {
      ...outcome,
      judge: {
        verdict: 'inconclusive',
        missing: [],
        modelCalls: 0,
        note: error instanceof Error ? error.message : String(error),
        deltaMessages: steps.length,
      },
    };
  }
}

async function runAll(cases: readonly ReplayCase[], options: Options): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < cases.length) {
      const index = next++;
      const item = cases[index];
      const result = await runCase(item, options);
      results[index] = result;
      console.log(
        `[${index + 1}/${cases.length}] ${item.sessionId.slice(0, 8)} ${result.replayModel}: ${result.status}` +
          `${result.strategy ? ` ${result.strategy}` : ''}${result.degraded ? ' degraded' : ''}` +
          ` post=${result.postTokens ?? '-'} retained=${result.retainedCount ?? '-'}` +
          ` ${Math.round(result.wallMs / 1000)}s judge=${result.judge?.verdict ?? '-'}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, cases.length) }, worker));
  return results;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(results: readonly CaseResult[]) {
  const compacted = results.filter((result) => result.status === 'compacted');
  const judged = compacted.filter((result) => result.judge);
  const count = (predicate: (result: CaseResult) => boolean): number =>
    results.filter(predicate).length;
  return {
    cases: results.length,
    compacted: compacted.length,
    failed: count((result) => result.status === 'failed'),
    skipped: count((result) => result.status === 'skipped'),
    degraded: count((result) => result.degraded === true),
    summaryIsJson: count((result) => result.summaryIsJson === true),
    retainedEmpty: compacted.filter((result) => (result.retainedCount ?? 0) === 0).length,
    medianPostTokens: median(compacted.map((result) => result.postTokens ?? 0)),
    medianWallMs: median(results.map((result) => result.wallMs)),
    medianModelCalls: median(compacted.map((result) => result.modelCalls ?? 0)),
    judged: judged.length,
    judgeAccepted: judged.filter((result) => result.judge?.verdict === 'accepted').length,
    judgeRejected: judged.filter((result) => result.judge?.verdict === 'rejected').length,
    judgeInconclusive: judged.filter((result) => result.judge?.verdict === 'inconclusive').length,
    promptTokens: results.reduce((sum, result) => sum + result.promptTokens, 0),
    completionTokens: results.reduce((sum, result) => sum + result.completionTokens, 0),
  };
}

function renderMarkdown(
  label: string,
  results: readonly CaseResult[],
  totals: ReturnType<typeof summarize>,
): string {
  const lines = [
    `# Compaction replay: ${label}`,
    '',
    `- Cases: ${totals.cases} (compacted ${totals.compacted}, failed ${totals.failed}, skipped ${totals.skipped})`,
    `- Degraded: ${totals.degraded}; summary stored as raw JSON: ${totals.summaryIsJson}`,
    `- Retained tail empty: ${totals.retainedEmpty} of ${totals.compacted}`,
    `- Median post tokens: ${totals.medianPostTokens ?? '-'}; median wall: ${Math.round((totals.medianWallMs ?? 0) / 1000)} s; median model calls: ${totals.medianModelCalls ?? '-'}`,
    `- Judge (real next steps): ${totals.judgeAccepted} accepted, ${totals.judgeRejected} rejected, ${totals.judgeInconclusive} inconclusive of ${totals.judged}`,
    `- Tokens: ${totals.promptTokens.toLocaleString()} prompt, ${totals.completionTokens.toLocaleString()} completion`,
    '',
    '| Session | Model | Orig strategy | Status | Strategy | Degraded | Reasons | Calls | Pre → post | Retained | Carried | Summary | Wall | Judge |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    const missing = result.judge?.missing.length ? ` (${result.judge.missing.join('; ')})` : '';
    lines.push(
      `| ${result.sessionId.slice(0, 8)} | ${result.replayModel} | ${result.original.strategy ?? '-'}${result.original.degraded ? ' (degraded)' : ''} | ${result.status}${result.reason ? ` ${result.reason}` : ''} | ${result.strategy ?? '-'} | ${result.degraded ? 'yes' : 'no'} | ${result.coverageReasons?.join(', ') ?? '-'} | ${result.modelCalls ?? '-'} | ${result.preTokens ?? '-'} → ${result.postTokens ?? '-'} | ${result.retainedCount ?? '-'} | ${result.carriedCount ?? '-'} | ${result.summaryChars ?? '-'}${result.summaryIsJson ? ' json' : ''} | ${Math.round(result.wallMs / 1000)} s | ${result.judge?.verdict ?? '-'}${missing.replace(/\|/g, '/')} |`,
    );
    if (result.error)
      lines.push(
        `| | error: ${result.error.replace(/\|/g, '/').slice(0, 300)} | | | | | | | | | | | | |`,
      );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cases = discoverCases(options);
  if (cases.length === 0) {
    console.log('No compact records matched.');
    return;
  }
  console.log(`Replaying ${cases.length} compaction(s) from ${options.sessionsDir}`);
  const results = await runAll(cases, options);
  const totals = summarize(results);
  mkdirSync(options.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const base = join(options.outDir, `compact-replay-${options.label}-${stamp}`);
  writeFileSync(`${base}.json`, `${JSON.stringify({ options, totals, results }, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderMarkdown(options.label, results, totals));
  console.log(JSON.stringify(totals, null, 2));
  console.log(`Report: ${base}.md`);
}

await main();
