/**
 * Tool-discovery eval (#619): how a model reaches a deferred tool under each discovery arm, on
 * tasks that each need one deferred tool. Each run gets a throwaway workspace and Book home
 * (`runEvaluationProcess`) and the print-mode runner (`tool-discovery-eval-worker.ts`).
 *
 * Usage:
 *   npm run eval:tools -- --mock                   # the whole matrix on scripted models, no key
 *   npm run eval:tools -- --mock --estimate        # then the cost of the real matrix
 *   npm run eval:tools -- --estimate --from .book/reports/tool-discovery-eval-mock-….json
 *   npm run eval:tools -- --model anthropic/claude-haiku-5-5 --model <provider/model> …
 *
 * Run with --help for the options. A run with --model calls that provider and costs money; it is
 * never part of CI.
 */

import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { resolveModelPricing, usageCostUsd, type ModelPricing } from '../src/pricing.js';
import { isAnthropicProvider } from '../src/provider/index.js';
import { createEditEvaluationSettings, runCommand } from './edit-eval.js';
import {
  evaluationControlsFromResult,
  runEvaluationProcess,
  type EvaluationControls,
} from './eval-process.js';
import {
  MOCK_POLICIES,
  mockModelId,
  startMockProvider,
  type MockPolicy,
} from './tool-discovery-eval-mock.js';
import {
  FIXTURE_PAGES,
  TOOL_EVAL_TASKS,
  type ToolEvalFixture,
  type ToolEvalTask,
} from './tool-discovery-eval-tasks.js';
import { FIXTURE_URL_ENV, type ToolEvalWorkerOutcome } from './tool-discovery-eval-worker.js';

/**
 * The discovery arms. The count-only catalog from before deferral PR 1 no longer exists, so there
 * is no arm for it: `baseline` is PR 1's catalog (every deferred tool listed by name, `select:`)
 * with direct calls off and no routing.
 */
export const TOOL_EVAL_ARMS = ['baseline', '+direct', '+routing'] as const;
export type ToolEvalArm = (typeof TOOL_EVAL_ARMS)[number];

export const ARM_DESCRIPTIONS: Record<ToolEvalArm, string> = {
  baseline: 'deferred tools listed by name and `select:`; direct calls off; no routing',
  '+direct': 'direct calls to a deferred tool run just in time; no routing',
  '+routing': 'direct calls, and intent routing before the first model call',
};

/**
 * The settings an arm adds to a run's isolated settings. The arm is the harness's own choice, not
 * a user setting: `baseline` turns direct calls off the way production does, with a hook whose
 * matcher names ToolSearch (one that does nothing, so ToolSearch itself runs as ever); that gate
 * also refuses routing. `toolDiscovery.intentRouting` turns routing off for the other arm.
 */
export function armSettings(arm: ToolEvalArm): Record<string, unknown> {
  return {
    toolDiscovery: { intentRouting: arm === '+routing' },
    ...(arm === 'baseline'
      ? { hooks: { PostToolUse: [{ matcher: 'ToolSearch', command: 'exit 0' }] } }
      : {}),
  };
}

/** The models of the plan's eval (§5 item 3). Provider and model ids come from `--model`. */
export const PLAN_MODELS: ReadonlyArray<{
  label: string;
  tier: 'weak' | 'strong';
  pricing?: string;
}> = [
  { label: 'MiniMax M3.1 Flash', tier: 'weak' },
  { label: 'Muse Spark', tier: 'weak' },
  { label: 'Gemini 3.8 Flash', tier: 'weak' },
  { label: 'Haiku 5.5', tier: 'weak', pricing: 'claude-haiku-5-5' },
  { label: 'Sonnet 5.5', tier: 'strong', pricing: 'claude-sonnet-5-5' },
  { label: 'Opus 5.5', tier: 'strong', pricing: 'claude-opus-5-5' },
];

export interface ToolEvalOutcome extends ToolEvalWorkerOutcome {
  arm: ToolEvalArm;
  /** The scripted policy in mock mode, else the `--model` route. */
  model: string;
  trial: number;
  /** An Anthropic route, whose cache-read ratio the report shows. */
  anthropic: boolean;
  controls?: EvaluationControls;
}

export interface ToolEvalReport {
  mode: 'mock' | 'real';
  generatedAt: string;
  trials: number;
  outcomes: ToolEvalOutcome[];
}

const TASK_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.BOOK_EVAL_TIMEOUT_MS ?? NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
})();
const WORKER = fileURLToPath(new URL('./tool-discovery-eval-worker.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx');
const DEFAULT_MOCK_PORT = 9086;

export interface ToolEvalArgs {
  help: boolean;
  mock: boolean;
  mockPort: number;
  models: string[];
  arms: ToolEvalArm[];
  tasks: string[];
  trials?: number;
  estimate: boolean;
  from?: string;
  outputTokensPerRequest: number;
  rates: Record<string, ModelPricing>;
}

/** `--rate <model>=<in>,<out>[,<cache read>,<cache write>]`, $ per million tokens. */
function parseRate(raw: string, rates: Record<string, ModelPricing>): void {
  const at = raw.lastIndexOf('=');
  const values = raw
    .slice(at + 1)
    .split(',')
    .map(Number);
  if (
    at <= 0 ||
    values.length < 2 ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error(`--rate expects <model>=<in>,<out>[,<cache read>,<cache write>]: ${raw}`);
  }
  const [input, output, cacheRead, cacheCreation] = values;
  rates[raw.slice(0, at)] = { in: input, out: output, cacheRead, cacheCreation };
}

export function parseToolEvalArgs(argv: readonly string[]): ToolEvalArgs {
  const args: ToolEvalArgs = {
    help: false,
    mock: false,
    mockPort: DEFAULT_MOCK_PORT,
    models: [],
    arms: [...TOOL_EVAL_ARMS],
    tasks: TOOL_EVAL_TASKS.map((task) => task.name),
    estimate: false,
    outputTokensPerRequest: 400,
    rates: {},
  };
  const list = (value: string | undefined) => (value ?? '').split(',').filter(Boolean);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--mock') args.mock = true;
    else if (flag === '--mock-port') args.mockPort = Number(value());
    else if (flag === '--model') args.models.push(value());
    else if (flag === '--arm') {
      const arms = list(value());
      const unknown = arms.filter((arm) => !TOOL_EVAL_ARMS.includes(arm as ToolEvalArm));
      if (unknown.length > 0) throw new Error(`Unknown arm: ${unknown.join(', ')}`);
      args.arms = arms as ToolEvalArm[];
    } else if (flag === '--task') {
      const tasks = list(value());
      const unknown = tasks.filter((task) => !TOOL_EVAL_TASKS.some(({ name }) => name === task));
      if (unknown.length > 0) throw new Error(`Unknown task: ${unknown.join(', ')}`);
      args.tasks = tasks;
    } else if (flag === '--trials') args.trials = Number(value());
    else if (flag === '--estimate') args.estimate = true;
    else if (flag === '--from') args.from = value();
    else if (flag === '--output-tokens') {
      const raw = value();
      args.outputTokensPerRequest = Number(raw);
      if (!Number.isInteger(args.outputTokensPerRequest) || args.outputTokensPerRequest <= 0) {
        throw new Error(`--output-tokens expects a positive integer: ${raw}`);
      }
    } else if (flag === '--rate') parseRate(value(), args.rates);
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (args.trials !== undefined && !(Number.isInteger(args.trials) && args.trials > 0)) {
    throw new Error('--trials expects a positive integer.');
  }
  if (!Number.isInteger(args.mockPort) || args.mockPort < 0) {
    throw new Error('--mock-port expects a port number.');
  }
  if (args.mock && args.models.length > 0) {
    throw new Error('--mock runs scripted models; leave out --model.');
  }
  return args;
}

export const USAGE = [
  'Usage: npm run eval:tools -- (--mock | --model <provider/model> …) [options]',
  '       npm run eval:tools -- --estimate [--from <mock report.json>] [options]',
  '',
  'Runs each task under each arm and writes a JSON and Markdown report to .book/reports/.',
  '',
  '  --mock                 scripted models (weak, naive, searching) on a local mock provider',
  `  --mock-port <port>     the mock provider's port (default ${DEFAULT_MOCK_PORT}; 0 = any free port)`,
  '  --model <provider/m>   a real model; repeat for several. Costs money: needs the owner',
  '                         to approve the budget (estimate it first)',
  `  --arm <a,b>            arms to run (default all: ${TOOL_EVAL_ARMS.join(', ')})`,
  `  --task <a,b>           tasks to run (default all: ${TOOL_EVAL_TASKS.map((task) => task.name).join(', ')})`,
  '  --trials <n>           trials per task and arm (default 1 with --mock, else 3)',
  '  --estimate             print the estimated USD of the real matrix from a mock run: this',
  '                         one with --mock, else --from or the newest mock report. Runs no',
  '                         real model; --model then names the models to price',
  '  --output-tokens <n>    output tokens assumed per real request (default 400)',
  '  --rate <m>=<in>,<out>[,<cache read>,<cache write>]',
  '                         $ per million tokens for a model src/pricing.ts has no rate for',
  '',
  'Arms:',
  ...TOOL_EVAL_ARMS.map((arm) => `  ${arm.padEnd(10)} ${ARM_DESCRIPTIONS[arm]}`),
  '',
  "The plan's models (pass their provider/model ids with --model):",
  ...PLAN_MODELS.map((model) => `  ${model.tier.padEnd(7)} ${model.label}`),
  '',
  'Network: WebFetch reads a local fixture server; WebSearch and the session history answer from',
  'fixtures. A real run needs only its provider, except a real model that falls back to curl for',
  'the web-search task, which reaches the internet.',
].join('\n');

/** The fixture server the fetch task and the curl fallbacks read, on 127.0.0.1. */
export async function startFixtureServer(): Promise<ToolEvalFixture & { close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const body = FIXTURE_PAGES[new URL(req.url ?? '/', 'http://fixture').pathname];
    if (body === undefined) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    else res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * Write the task's files and commits into `workspace`. Commits use a fixed identity with signing
 * off, whatever the user's git configuration says, and any git command that fails fails the seed,
 * so a run never measures a workspace that is missing its fixture.
 */
export async function seedWorkspace(
  task: ToolEvalTask,
  workspace: string,
  run: typeof runCommand = runCommand,
): Promise<void> {
  const git = async (args: string[]) => {
    const code = await run('git', args, workspace);
    if (code !== 0) {
      throw new Error(
        `Seeding the ${task.name} workspace failed: git ${args.join(' ')} exited with ${code ?? 'no code'}.`,
      );
    }
  };
  await git(['init', '--quiet']);
  const commits = [...(task.commits ?? [])];
  if (task.files) commits.push({ message: 'Add the task files', files: task.files });
  for (const commit of commits) {
    for (const [path, content] of Object.entries(commit.files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content, 'utf8');
    }
    await git(['add', '-A']);
    await git([
      '-c',
      'user.email=eval@book',
      '-c',
      'user.name=book-eval',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      commit.message,
    ]);
  }
}

/** Settings for a scripted model on the mock provider, shaped like `createEditEvaluationSettings`. */
export function mockEvaluationSettings(
  model: string,
  providerUrl: string,
): Record<string, unknown> {
  return {
    model: `mock/${model}`,
    provider: {
      mock: { type: 'openai', baseURL: providerUrl, apiKey: 'mock-key', models: { [model]: {} } },
    },
    agents: { mode: 'off' },
    memory: { enabled: false },
    skills: { enabled: false },
    observability: { toolTelemetry: false },
  };
}

/** A run's isolated settings with the arm's added; `toolDiscovery` merges, the rest replaces. */
export function withArm(
  settings: Record<string, unknown>,
  arm: ToolEvalArm,
): Record<string, unknown> {
  const added = armSettings(arm);
  return {
    ...settings,
    ...added,
    toolDiscovery: {
      ...(settings.toolDiscovery as Record<string, unknown> | undefined),
      ...(added.toolDiscovery as Record<string, unknown>),
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** The worker's last stdout line, checked to be this task's outcome. */
export function parseWorkerOutcome(stdout: string, task: ToolEvalTask): ToolEvalWorkerOutcome {
  const line = stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error('Tool-discovery evaluation worker returned no result.');
  const parsed: unknown = JSON.parse(line);
  const counts = ['modelTurns', 'fallbacks', 'toolSearchMisses', 'refusals', 'unknownTools'];
  if (
    !isRecord(parsed) ||
    parsed.task !== task.name ||
    parsed.target !== task.target ||
    typeof parsed.success !== 'boolean' ||
    typeof parsed.verified !== 'boolean' ||
    !counts.every((key) => Number.isInteger(parsed[key])) ||
    (parsed.firstCorrectCallTurn !== undefined && !Number.isInteger(parsed.firstCorrectCallTurn)) ||
    (parsed.runError !== undefined && typeof parsed.runError !== 'string')
  ) {
    throw new Error('Tool-discovery evaluation worker returned a malformed or mismatched result.');
  }
  return parsed as unknown as ToolEvalWorkerOutcome;
}

interface RunTarget {
  /** The outcome's model label. */
  label: string;
  anthropic: boolean;
  settings(task: ToolEvalTask): Record<string, unknown>;
  env: Record<string, string>;
}

async function runTask(
  task: ToolEvalTask,
  arm: ToolEvalArm,
  target: RunTarget,
  trial: number,
  fixture: ToolEvalFixture,
): Promise<ToolEvalOutcome> {
  const startedAt = Date.now();
  const failed = (runError: string): ToolEvalWorkerOutcome => ({
    task: task.name,
    target: task.target,
    success: false,
    verified: false,
    modelTurns: 0,
    fallbacks: 0,
    toolSearchMisses: 0,
    refusals: 0,
    unknownTools: 0,
    runError,
    durationMs: Date.now() - startedAt,
  });
  let outcome: ToolEvalWorkerOutcome;
  let controls: EvaluationControls | undefined;
  try {
    const processResult = await runEvaluationProcess({
      command: process.execPath,
      args: ['--import', TSX_LOADER, WORKER, '--task', task.name],
      timeoutMs: TASK_TIMEOUT_MS,
      env: {
        ...target.env,
        [FIXTURE_URL_ENV]: fixture.baseUrl,
        // WebFetch refuses plain HTTP and private addresses by default; the fixture is both.
        BOOK_WEB_ALLOW_HTTP: 'true',
        BOOK_WEB_ALLOW_PRIVATE_NETWORK: 'true',
      },
      prepare: async ({ workspace, bookHome }) => {
        await seedWorkspace(task, workspace);
        await writeFile(
          join(bookHome, 'settings.json'),
          JSON.stringify(withArm(target.settings(task), arm), null, 2),
          'utf8',
        );
      },
    });
    controls = evaluationControlsFromResult(processResult);
    outcome =
      processResult.status === 'completed'
        ? parseWorkerOutcome(processResult.stdout, task)
        : failed(processResult.stderr.trim() || `Evaluation process ${processResult.status}.`);
  } catch (error) {
    outcome = failed(error instanceof Error ? error.message : String(error));
  }
  return {
    ...outcome,
    arm,
    model: target.label,
    trial,
    anthropic: target.anthropic,
    controls,
    durationMs: Date.now() - startedAt,
  };
}

export interface ToolEvalSummary {
  model: string;
  arm: ToolEvalArm;
  runs: number;
  successes: number;
  verified: number;
  /** Over the runs that made a correct call. */
  meanTurnsToFirstCall?: number;
  fallbacks: number;
  toolSearchMisses: number;
  refusals: number;
  unknownTools: number;
  meanTokens?: number;
  /** Cache-read tokens over all input tokens. */
  cacheReadRatio?: number;
}

const mean = (values: number[]): number | undefined =>
  values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : undefined;

export function summarize(outcomes: readonly ToolEvalOutcome[]): ToolEvalSummary[] {
  const groups = new Map<string, ToolEvalOutcome[]>();
  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.model, outcome.arm]);
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  return [...groups.values()].map((group) => {
    const sum = (pick: (outcome: ToolEvalOutcome) => number) =>
      group.reduce((total, outcome) => total + pick(outcome), 0);
    const withUsage = group.filter((outcome) => outcome.usage);
    const input = withUsage.reduce((total, outcome) => total + outcome.usage!.inputTokens, 0);
    return {
      model: group[0].model,
      arm: group[0].arm,
      runs: group.length,
      successes: group.filter((outcome) => outcome.success).length,
      verified: group.filter((outcome) => outcome.verified).length,
      meanTurnsToFirstCall: mean(
        group.flatMap((outcome) =>
          outcome.firstCorrectCallTurn === undefined ? [] : [outcome.firstCorrectCallTurn],
        ),
      ),
      fallbacks: sum((outcome) => outcome.fallbacks),
      toolSearchMisses: sum((outcome) => outcome.toolSearchMisses),
      refusals: sum((outcome) => outcome.refusals),
      unknownTools: sum((outcome) => outcome.unknownTools),
      meanTokens: mean(
        group.flatMap((outcome) =>
          outcome.totalTokens === undefined ? [] : [outcome.totalTokens],
        ),
      ),
      cacheReadRatio:
        input > 0
          ? withUsage.reduce((total, outcome) => total + outcome.usage!.cacheReadTokens, 0) / input
          : undefined,
    };
  });
}

/** Tasks routing serves: their prompts carry a URL or search intent. */
const ROUTED_TASKS = new Set(['fetch-url', 'web-search']);

/**
 * The model turn of the first correct call each scripted model must make under each arm, if the
 * harness measures what it claims; undefined where it must never make one (the weak model working
 * around a tool nobody declared).
 */
export function expectedFirstCallTurn(
  policy: MockPolicy,
  arm: ToolEvalArm,
  task: string,
): number | undefined {
  const routed = arm === '+routing' && ROUTED_TASKS.has(task);
  if (policy === 'naive') return arm === 'baseline' ? 3 : 1;
  if (policy === 'searching') return routed ? 1 : 2;
  return routed ? 1 : undefined;
}

/** Where a mock run departs from what each arm must do to each scripted model. */
export function mockSignatureFailures(outcomes: readonly ToolEvalOutcome[]): string[] {
  const failures: string[] = [];
  for (const outcome of outcomes) {
    const where = `${outcome.model} / ${outcome.arm} / ${outcome.task}`;
    const expected = expectedFirstCallTurn(outcome.model as MockPolicy, outcome.arm, outcome.task);
    if (outcome.runError) failures.push(`${where}: run error ${outcome.runError}`);
    if (outcome.firstCorrectCallTurn !== expected) {
      failures.push(
        `${where}: first correct call at turn ${outcome.firstCorrectCallTurn ?? 'never'}, expected ${expected ?? 'never'}`,
      );
    }
    if (outcome.success !== (expected !== undefined)) {
      failures.push(`${where}: success ${outcome.success}, expected ${expected !== undefined}`);
    }
    const refused = outcome.model === 'naive' && outcome.arm === 'baseline';
    if (outcome.refusals > 0 !== refused) {
      failures.push(
        `${where}: ${outcome.refusals} refusals, expected ${refused ? 'some' : 'none'}`,
      );
    }
    if (outcome.fallbacks > 0 !== (expected === undefined)) {
      failures.push(`${where}: ${outcome.fallbacks} fallbacks`);
    }
    if (outcome.toolSearchMisses > 0) {
      failures.push(`${where}: ${outcome.toolSearchMisses} ToolSearch misses`);
    }
  }
  return failures;
}

export interface EstimateModel {
  label: string;
  /** The id `src/pricing.ts` prices it by, when it has one. */
  pricing?: string;
  anthropic: boolean;
  rate?: ModelPricing;
}

/** The plan's models, or the `--model` routes, with their rates. */
export function estimateModels(
  routes: readonly string[],
  rates: Readonly<Record<string, ModelPricing>>,
): EstimateModel[] {
  const models =
    routes.length > 0
      ? routes.map((route) => ({ label: route, pricing: route.split('/').at(-1) }))
      : PLAN_MODELS.map(({ label, pricing }) => ({ label, pricing }));
  return models.map(({ label, pricing }) => ({
    label,
    pricing,
    anthropic: pricing?.startsWith('claude-') ?? false,
    rate:
      rates[label] ??
      (pricing ? (rates[pricing] ?? resolveModelPricing(pricing, rates)?.rate) : undefined),
  }));
}

export interface TaskFigure {
  task: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
}

/**
 * Per arm and task, the scripted run that sent the most input: an upper bound over the scripts. A
 * real model that explores more than a script does costs more; the scripts' turn count is a floor.
 */
export function armTaskFigures(
  outcomes: readonly ToolEvalOutcome[],
): Map<ToolEvalArm, TaskFigure[]> {
  const figures = new Map<ToolEvalArm, TaskFigure[]>();
  for (const arm of TOOL_EVAL_ARMS) {
    const rows: TaskFigure[] = [];
    for (const task of TOOL_EVAL_TASKS) {
      const runs = outcomes.filter(
        (outcome) => outcome.arm === arm && outcome.task === task.name && outcome.usage,
      );
      if (runs.length === 0) continue;
      const largest = runs.reduce((best, run) =>
        run.usage!.inputTokens > best.usage!.inputTokens ? run : best,
      );
      rows.push({
        task: task.name,
        requests: Math.max(1, largest.modelTurns),
        inputTokens: largest.usage!.inputTokens,
        cacheReadTokens: largest.usage!.cacheReadTokens,
      });
    }
    if (rows.length > 0) figures.set(arm, rows);
  }
  return figures;
}

/**
 * The USD of one trial of every task in `figures` on `model`, priced request by request (a tiered
 * rate reads one request's prompt, never a task's sum) at `outputTokensPerRequest` output tokens a
 * request. Anthropic reads what the conversation's previous request cached at the cache-read rate
 * and writes the rest at the cache-write rate, as Book's breakpoints do; any other route is priced
 * with no cache at all, an upper bound. Undefined without a rate.
 */
export function trialCostUsd(
  figures: readonly TaskFigure[],
  model: EstimateModel,
  outputTokensPerRequest: number,
): number | undefined {
  if (!model.rate) return undefined;
  let total = 0;
  for (const figure of figures) {
    const input = figure.inputTokens / figure.requests;
    const cached = figure.cacheReadTokens / figure.requests;
    const request = model.anthropic
      ? {
          promptTokens: 0,
          cacheReadInputTokens: cached,
          cacheCreationInputTokens: input - cached,
          completionTokens: outputTokensPerRequest,
        }
      : { promptTokens: input, completionTokens: outputTokensPerRequest };
    total += figure.requests * usageCostUsd(model.rate, request, 'request');
  }
  return total;
}

/**
 * The estimate the options ask for. It never runs a real model: `--model` only names the models it
 * prices (the plan's six without it), and `--trials` the trials of the full run (3 without it).
 */
export function estimateFromArgs(args: ToolEvalArgs, outcomes: readonly ToolEvalOutcome[]): string {
  return renderEstimate(
    outcomes,
    estimateModels(args.mock ? [] : args.models, args.rates),
    args.outputTokensPerRequest,
    args.trials ?? 3,
  );
}

const usd = (value: number | undefined): string =>
  value === undefined ? 'no rate' : `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;

/** The estimate as Markdown: USD per arm, model and trial, then one full run at `trials`. */
export function renderEstimate(
  outcomes: readonly ToolEvalOutcome[],
  models: readonly EstimateModel[],
  outputTokensPerRequest: number,
  trials = 3,
): string {
  const figures = armTaskFigures(outcomes);
  const arms = TOOL_EVAL_ARMS.filter((arm) => figures.has(arm));
  const lines = [
    '| Model | ' +
      arms.map((arm) => `${arm} / trial`).join(' | ') +
      ` | ${trials} trials, all arms |`,
    '| --- | ' + arms.map(() => '---').join(' | ') + ' | --- |',
  ];
  let total = 0;
  const unpriced: string[] = [];
  for (const model of models) {
    const cells = arms.map((arm) => trialCostUsd(figures.get(arm)!, model, outputTokensPerRequest));
    const run = cells.every((cell) => cell !== undefined)
      ? cells.reduce<number>((sum, cell) => sum + cell! * trials, 0)
      : undefined;
    if (run === undefined) unpriced.push(model.label);
    else total += run;
    lines.push(`| ${model.label} | ${cells.map(usd).join(' | ')} | ${usd(run)} |`);
  }
  const tasks = new Set([...figures.values()].flat().map((figure) => figure.task));
  return [
    ...lines,
    '',
    `One full run (${tasks.size} tasks × ${arms.length} arms × ${models.length} models × ${trials} trials): **${usd(total)}**` +
      (unpriced.length > 0 ? `, not counting ${unpriced.join(', ')} (no rate; pass --rate)` : '') +
      '.',
    '',
    `Assumptions: the input of the scripted run that sent the most on each task and arm (mock usage is chars/4 of the real request, so Book's real system prompt and tools); ${outputTokensPerRequest} output tokens a request; Anthropic reads the simulated prefix cache and writes the rest, other routes pay full input. A real model that explores more than the scripts costs more: the scripts' 2–4 requests a task are a floor.`,
  ].join('\n');
}

const pct = (value: number | undefined): string =>
  value === undefined ? '—' : `${(value * 100).toFixed(0)}%`;
const num = (value: number | undefined, digits = 1): string =>
  value === undefined ? '—' : value.toFixed(digits);

export function renderReport(report: ToolEvalReport, estimate?: string): string {
  const failures = report.mode === 'mock' ? mockSignatureFailures(report.outcomes) : [];
  const ratioNote =
    report.mode === 'mock'
      ? 'simulated: the mock reads back each leading segment the previous request sent unchanged'
      : 'Anthropic routes only';
  return [
    `# Tool discovery eval — ${report.mode === 'mock' ? 'mock (scripted models)' : 'real models'}`,
    '',
    `- Date: ${report.generatedAt}`,
    `- Trials: ${report.trials}`,
    ...TOOL_EVAL_ARMS.map((arm) => `- \`${arm}\`: ${ARM_DESCRIPTIONS[arm]}`),
    '- The count-only catalog from before deferral PR 1 no longer exists, so it has no arm.',
    "- Fixtures: WebFetch reads the eval's fixture server on 127.0.0.1 (the worker sets `BOOK_WEB_ALLOW_HTTP` and `BOOK_WEB_ALLOW_PRIVATE_NETWORK`); WebSearch and the session history answer from fixtures.",
    ...(report.mode === 'mock'
      ? [
          `- Scripted models: ${MOCK_POLICIES.join(', ')}. Signature check: ${
            failures.length === 0 ? '**pass**' : `**${failures.length} failures**`
          }`,
          ...failures.map((failure) => `  - ${failure}`),
        ]
      : []),
    '',
    '## Summary',
    '',
    `Cache-read ratio: ${ratioNote}.`,
    '',
    '| Model | Arm | Success | Verified | Turns to first call | Fallbacks | ToolSearch misses | Refusals | Unknown tools | Tokens / task | Cache-read ratio |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summarize(report.outcomes).map(
      (row) =>
        `| ${row.model} | ${row.arm} | ${row.successes}/${row.runs} | ${row.verified}/${row.runs} | ${num(row.meanTurnsToFirstCall)} | ${row.fallbacks} | ${row.toolSearchMisses} | ${row.refusals} | ${row.unknownTools} | ${num(row.meanTokens, 0)} | ${
          report.mode === 'mock' ||
          report.outcomes.some((o) => o.model === row.model && o.anthropic)
            ? pct(row.cacheReadRatio)
            : '—'
        } |`,
    ),
    '',
    '## Runs',
    '',
    '| Model | Arm | Task | Trial | Result | First call | Turns | Fallbacks | Misses | Refusals | Unknown | Tokens | Error |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.outcomes.map(
      (outcome) =>
        `| ${outcome.model} | ${outcome.arm} | ${outcome.task} | ${outcome.trial} | ${
          outcome.success ? 'pass' : outcome.verified ? 'verified only' : 'FAIL'
        } | ${outcome.firstCorrectCallTurn ?? '—'} | ${outcome.modelTurns} | ${outcome.fallbacks} | ${outcome.toolSearchMisses} | ${outcome.refusals} | ${outcome.unknownTools} | ${outcome.totalTokens ?? '—'} | ${(outcome.runError ?? '').slice(0, 80).replace(/\|/g, '/')} |`,
    ),
    ...(estimate ? ['', '## Estimated cost of the real matrix', '', estimate] : []),
    '',
  ].join('\n');
}

async function newestMockReport(reportDir: string): Promise<string> {
  const names = (await readdir(reportDir).catch(() => []))
    .filter((name) => /^tool-discovery-eval-mock-.*\.json$/.test(name))
    .sort();
  const newest = names.at(-1);
  if (!newest) throw new Error('No mock report under .book/reports; run with --mock first.');
  return join(reportDir, newest);
}

async function main(): Promise<void> {
  const args = parseToolEvalArgs(process.argv.slice(2));
  if (args.help || (!args.mock && args.models.length === 0 && !args.estimate)) {
    console.log(USAGE);
    return;
  }
  const reportDir = join(process.cwd(), '.book', 'reports');
  if (args.estimate && !args.mock) {
    const from = args.from ?? (await newestMockReport(reportDir));
    const report = JSON.parse(await readFile(from, 'utf8')) as ToolEvalReport;
    console.log(`Estimate from ${from}\n`);
    console.log(estimateFromArgs(args, report.outcomes));
    return;
  }

  const trials = args.trials ?? (args.mock ? 1 : 3);
  const tasks = TOOL_EVAL_TASKS.filter((task) => args.tasks.includes(task.name));
  const fixture = await startFixtureServer();
  const mock = args.mock ? await startMockProvider(args.mockPort, fixture) : undefined;
  const targets: RunTarget[] = [];
  if (mock) {
    for (const policy of MOCK_POLICIES) {
      targets.push({
        label: policy,
        anthropic: false,
        settings: (task) => mockEvaluationSettings(mockModelId(policy, task.name), mock.baseUrl),
        env: {},
      });
    }
  } else {
    for (const route of args.models) {
      const configWorkspace = await mkdtemp(join(tmpdir(), 'book-tool-eval-config-'));
      try {
        const config = loadConfig(configWorkspace, { modelOverride: route });
        const settings = createEditEvaluationSettings(config);
        targets.push({
          label: route,
          anthropic: isAnthropicProvider(config),
          settings: () => settings,
          env: { BOOK_API_KEY: config.apiKey },
        });
      } finally {
        await rm(configWorkspace, { recursive: true, force: true });
      }
    }
  }

  const outcomes: ToolEvalOutcome[] = [];
  try {
    const total = targets.length * args.arms.length * tasks.length * trials;
    console.log(`tool-discovery eval: ${total} run(s), ${args.mock ? 'mock' : 'real'} mode\n`);
    for (const target of targets) {
      for (const arm of args.arms) {
        for (const task of tasks) {
          for (let trial = 1; trial <= trials; trial++) {
            process.stdout.write(`  ${target.label} ${arm} ${task.name} #${trial} ... `);
            const outcome = await runTask(task, arm, target, trial, fixture);
            outcomes.push(outcome);
            console.log(
              `${outcome.success ? 'PASS' : outcome.verified ? 'verified only' : 'FAIL'} (first call ${outcome.firstCorrectCallTurn ?? '—'}, ${outcome.modelTurns} turns${outcome.runError ? `, ${outcome.runError.slice(0, 80)}` : ''})`,
            );
          }
        }
      }
    }
  } finally {
    await mock?.close();
    await fixture.close();
  }

  const report: ToolEvalReport = {
    mode: args.mock ? 'mock' : 'real',
    generatedAt: new Date().toISOString(),
    trials,
    outcomes,
  };
  const estimate = args.estimate ? estimateFromArgs(args, outcomes) : undefined;
  const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const baseName = `tool-discovery-eval-${report.mode}-${stamp}`;
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, `${baseName}.json`), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(reportDir, `${baseName}.md`), renderReport(report, estimate), 'utf8');
  if (estimate) console.log(`\n${estimate}`);
  console.log(`\nReport: .book/reports/${baseName}.md`);
  if (args.mock) {
    const failures = mockSignatureFailures(outcomes);
    if (failures.length > 0) {
      console.error(`\nThe arms did not differ as they must:\n${failures.join('\n')}`);
      process.exitCode = 1;
    }
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
