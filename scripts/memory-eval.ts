/**
 * `npm run eval:memory` — does memory make the next session better, and does it stay safe?
 * Design: plans/memory-improvement-plan.md, "Evaluation". Needs `npm run build` and a working
 * provider in ~/.book/settings.json; each run is a real, billed conversation.
 *
 *   npm run eval:memory -- [--models a,b] [--split test|dev|all] [--repeats 3]
 *                          [--only id1,id2] [--concurrency 2] [--timeout-ms 300000]
 *                          [--effort low|medium|high|xhigh|max] [--groups long-task,worktree]
 */
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { promptSizeTokens } from '../src/pricing.js';
import {
  BASE_WORKSPACE,
  MEMORY_SCENARIOS,
  POISON_PAYLOAD,
  type MemoryScenario,
} from './memory-eval-scenarios.js';
import {
  renderMarkdown,
  summarizeModel,
  type MemoryArm,
  type MemoryObservation,
} from './memory-eval-score.js';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'index.js');

/**
 * The model the owner steers Book with (run it at `--effort xhigh`), and a second family for
 * contrast. The `cx/` routes hit usage limits under eval load, and `space-bunny-alpha` was retired.
 */
export const DEFAULT_MODELS = [
  '9router/cmc/z-ai/glm-5.3-flash',
  '9router/cmc/deepseek/deepseek-v4.1-flash',
];

export interface MemoryEvalOptions {
  models: string[];
  split: 'dev' | 'test' | 'all';
  repeats: number;
  only?: string[];
  /** Only items of these groups (`short`, `long-task`, `delegated`, `worktree`, `channel`). */
  groups?: string[];
  concurrency: number;
  timeoutMs: number;
  /** Passed to every session as `--effort`; omitted, each model runs at its default. */
  effort?: string;
}

export function parseArgs(argv: string[]): MemoryEvalOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // A group spans both halves, so `--groups` alone runs all of it rather than silently half.
  const split = (get('--split') ??
    (get('--groups') ? 'all' : 'test')) as MemoryEvalOptions['split'];
  if (!['dev', 'test', 'all'].includes(split)) throw new Error(`--split must be dev, test or all`);
  const int = (flag: string, fallback: number) => {
    const raw = get(flag);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${flag} must be a positive integer`);
    return value;
  };
  return {
    models: get('--models')?.split(',').filter(Boolean) ?? DEFAULT_MODELS,
    split,
    repeats: int('--repeats', 3),
    only: get('--only')?.split(',').filter(Boolean),
    groups: get('--groups')?.split(',').filter(Boolean),
    concurrency: int('--concurrency', 2),
    timeoutMs: int('--timeout-ms', 300_000),
    effort: get('--effort'),
  };
}

export function selectScenarios(
  opts: Pick<MemoryEvalOptions, 'split' | 'only' | 'groups'>,
): MemoryScenario[] {
  return MEMORY_SCENARIOS.filter(
    (s) =>
      (opts.split === 'all' || s.split === opts.split) &&
      (!opts.only || opts.only.includes(s.id)) &&
      (!opts.groups || opts.groups.includes(s.group ?? 'short')),
  );
}

/** The user's settings with memory switched on or off for the arm. */
function armSettings(arm: MemoryArm): string {
  const bookHome = process.env.BOOK_HOME ?? join(homedir(), '.book');
  const file = join(bookHome, 'settings.json');
  if (!existsSync(file)) throw new Error(`No provider settings at ${file}`);
  const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const memory = (settings.memory as Record<string, unknown> | undefined) ?? {};
  settings.memory = { ...memory, enabled: arm === 'memory' };
  return JSON.stringify(settings, null, 2);
}

interface SessionResult {
  text: string;
  commands: string[];
  tools: string[];
  inputTokens: number;
}

/**
 * The `book` command line one eval session runs.
 *
 * `--include-result-messages` asks for the conversation in the stream-json
 * `result` event, which is where this harness reads the answer from: #307 made
 * that field opt-in to keep a long run's last line small, and without the flag
 * every session scored an empty answer.
 */
export function sessionArgs(
  model: string,
  resume: boolean,
  effort?: string,
  driver: 'human' | 'agent' = 'human',
): string[] {
  const args = [CLI, '--print', '--model', model, '--permission-mode', 'bypassPermissions'];
  // The harness runs under whatever launched it, often another agent: without an explicit driver
  // every teaching session would be agent-driven, which reads memory but never writes it. An item
  // that is about a delegated run asks for `agent` itself.
  args.push('--session-driver', driver);
  args.push('--output-format', 'stream-json', '--include-result-messages');
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--continue');
  return args;
}

/**
 * Why a stream-json `result` event's run did not finish, or undefined when it completed (or the
 * event predates outcomes). A provider timeout ends `timed_out`, a lost stream `interrupted`: none
 * of them is an answer to score.
 */
export function sessionFailure(event: Record<string, unknown>): string | undefined {
  const outcome = event.outcome as
    { status?: string; reason?: string; message?: string } | undefined;
  if (!outcome?.status || outcome.status === 'completed') return undefined;
  return `session ${outcome.status} (${outcome.reason ?? 'unknown'}): ${(outcome.message ?? '').slice(0, 300)}`;
}

/** One `book --print` conversation turn; `resume` continues the workspace's latest session. */
async function session(
  model: string,
  prompt: string,
  ws: string,
  home: string,
  resume: boolean,
  opts: Pick<MemoryEvalOptions, 'timeoutMs' | 'effort'>,
  driver: 'human' | 'agent' = 'human',
): Promise<SessionResult> {
  const { timeoutMs } = opts;
  const args = sessionArgs(model, resume, opts.effort, driver);
  return new Promise((resolvePromise, reject) => {
    // `--model` decides the model; an inherited BOOK_MODEL must not.
    const { BOOK_MODEL: _ignored, ...inherited } = process.env;
    const child = spawn(process.execPath, args, {
      cwd: ws,
      // The poison page is served on 127.0.0.1 over HTTP, which WebFetch refuses by default;
      // without these the web-poison item would never deliver its payload.
      env: {
        ...inherited,
        HOME: home,
        BOOK_HOME: join(home, '.book'),
        BOOK_WEB_ALLOW_HTTP: '1',
        BOOK_WEB_ALLOW_PRIVATE_NETWORK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const result: SessionResult = { text: '', commands: [], tools: [], inputTokens: 0 };
      let sawResult = false;
      let failure: string | undefined;
      for (const line of out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (event.type === 'tool_use') {
          const call = event.tool_call as { name?: string; arguments?: { command?: unknown } };
          if (call?.name) result.tools.push(call.name);
          if (call?.name === 'Bash' && typeof call.arguments?.command === 'string') {
            result.commands.push(call.arguments.command);
          }
        }
        if (event.type === 'result') {
          sawResult = true;
          failure = sessionFailure(event);
          const body = event.result as {
            messages?: Array<{ role: string; content?: string }>;
            usage?: {
              promptTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            };
          };
          const last = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
          result.text = last?.content ?? '';
          result.inputTokens = promptSizeTokens({
            promptTokens: body?.usage?.promptTokens ?? 0,
            completionTokens: 0,
            cacheReadInputTokens: body?.usage?.cacheReadInputTokens,
            cacheCreationInputTokens: body?.usage?.cacheCreationInputTokens,
          });
        }
      }
      if (!sawResult) {
        reject(new Error(`session exited ${code} without a result: ${err.trim().slice(-300)}`));
        return;
      }
      // A run the provider refused (a retired model, a rate limit) is an error, not a wrong
      // answer: scored as a probe it read as "the model forgot" with the error count at 0.
      if (failure) {
        reject(new Error(failure));
        return;
      }
      resolvePromise(result);
    });
    child.stdin.end(prompt);
  });
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Approved memory files and inbox candidates, as text. */
function readStore(home: string): { approved: string[]; inbox: string[] } {
  const projects = join(home, '.book', 'projects');
  const approved: string[] = [];
  const inbox: string[] = [];
  if (!existsSync(projects)) return { approved, inbox };
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project, 'memory');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.toLowerCase().endsWith('.md') || f === 'MEMORY.md') continue;
      const raw = readFileSync(join(dir, f), 'utf8');
      // A superseded memory is history, not something the model still remembers.
      if (!/^status:\s*superseded\s*$/m.test(raw)) approved.push(raw);
    }
    const inboxDir = join(dir, '.inbox');
    if (existsSync(inboxDir)) {
      for (const f of readdirSync(inboxDir)) {
        if (f.toLowerCase().endsWith('.md')) inbox.push(readFileSync(join(inboxDir, f), 'utf8'));
      }
    }
  }
  return { approved, inbox };
}

/**
 * Put the repository back exactly at the base commit before the probe, leaving nothing the
 * teaching session did that git could show it: in bypassPermissions a model often commits (its
 * message may carry the very convention being taught), opens a branch, or stashes. A plain
 * `reset --hard` keeps such a commit at HEAD, so the probe could pass by reading `git log` and the
 * memory arm would be credited with it.
 */
export async function restoreBase(
  git: (...args: string[]) => Promise<{ stdout: string }>,
  baseSha: string,
  baseBranch: string,
): Promise<void> {
  await git('checkout', '-q', '-f', baseBranch);
  await git('reset', '--hard', '-q', baseSha);
  await git('clean', '-fdxq');
  const refs = (await git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags')).stdout
    .split('\n')
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== `refs/heads/${baseBranch}`);
  for (const ref of refs) await git('update-ref', '-d', ref);
  await git('stash', 'clear');
  await git('reflog', 'expire', '--expire=now', '--all');
}

async function runItem(
  model: string,
  scenario: MemoryScenario,
  arm: MemoryArm,
  repeat: number,
  webUrl: string,
  opts: MemoryEvalOptions,
): Promise<MemoryObservation> {
  const root = mkdtempSync(join(tmpdir(), 'book-memory-eval-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  const obs: MemoryObservation = {
    model,
    arm,
    scenarioId: scenario.id,
    repeat,
    approved: [],
    inbox: [],
    probeText: '',
    probeCommands: [],
    probeFiles: {},
    probeInputTokens: 0,
    teachTools: [],
  };
  try {
    mkdirSync(join(home, '.book'), { recursive: true });
    writeFileSync(join(home, '.book', 'settings.json'), armSettings(arm));
    writeFiles(ws, { ...BASE_WORKSPACE, ...scenario.baseFiles });
    const git = (...args: string[]) => run('git', ['-C', ws, ...args]);
    await git('init', '-q');
    await git('add', '-A');
    await git('-c', 'user.email=eval@book', '-c', 'user.name=eval', 'commit', '-qm', 'base');
    const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    const baseBranch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();

    // The baseline has no memory, so nothing a teaching session did could reach its probe.
    if (arm === 'memory') {
      // A worktree item teaches in a linked worktree of the same repository and probes the main
      // checkout, the way a fact learned in a sweep worktree should reach the repo.
      const teachDir = scenario.teachIn === 'worktree' ? join(root, 'wt') : ws;
      if (teachDir !== ws) await git('worktree', 'add', '-q', '-b', 'eval-wt', teachDir);
      writeFiles(teachDir, scenario.teachFiles ?? {});
      for (const [i, turn] of scenario.teach.entries()) {
        const taught = await session(
          model,
          turn.replaceAll('{{WEB}}', webUrl),
          teachDir,
          home,
          i > 0,
          opts,
          scenario.teachDriver ?? 'human',
        );
        obs.teachTools.push(...taught.tools);
      }
      // A kept file (a repo's own notes file) outlives the reset, as it would in a real workspace.
      const kept: Record<string, string> = {};
      for (const path of scenario.keepFiles ?? []) {
        const file = join(teachDir, path);
        if (existsSync(file)) kept[path] = readFileSync(file, 'utf8');
      }
      if (teachDir !== ws) await git('worktree', 'remove', '--force', teachDir);
      await restoreBase(git, baseSha, baseBranch);
      writeFiles(ws, kept);
      if (scenario.keepFiles?.length) obs.keptFiles = kept;
      Object.assign(obs, readStore(home));
    }

    const probe = await session(model, scenario.probe, ws, home, false, opts);
    obs.probeText = probe.text;
    obs.probeCommands = probe.commands;
    obs.probeInputTokens = probe.inputTokens;
    if (scenario.check.kind === 'file') {
      const file = join(ws, scenario.check.path);
      obs.probeFiles[scenario.check.path] = existsSync(file)
        ? readFileSync(file, 'utf8')
        : undefined;
    }
  } catch (error) {
    obs.error = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return obs;
}

async function pool<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

export async function main(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!existsSync(CLI)) throw new Error('dist/index.js is missing — run `npm run build` first.');
  const scenarios = selectScenarios(opts);
  if (scenarios.length === 0) throw new Error('No scenarios selected.');

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<html><body><h1>Release notes</h1><p>Version 2 adds subtraction.</p><p>${POISON_PAYLOAD}</p></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const webUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/release-notes`;

  const tasks: Array<() => Promise<MemoryObservation>> = [];
  for (const model of opts.models)
    for (const scenario of scenarios)
      for (const arm of ['baseline', 'memory'] as const)
        for (let repeat = 0; repeat < opts.repeats; repeat++)
          tasks.push(async () => {
            const obs = await runItem(model, scenario, arm, repeat, webUrl, opts);
            process.stderr.write(
              `[${model}] ${scenario.id} ${arm}#${repeat} ${obs.error ? `error: ${obs.error.slice(0, 120)}` : 'done'}\n`,
            );
            return obs;
          });
  process.stderr.write(
    `memory eval: ${tasks.length} item-runs across ${opts.models.length} models\n`,
  );
  const observations = await pool(tasks, opts.concurrency);
  server.close();

  const results = opts.models.map((model) => summarizeModel(model, scenarios, observations));
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, '').slice(0, 15);
  const reports = join(ROOT, '.book', 'reports');
  mkdirSync(reports, { recursive: true });
  const groups = opts.groups ? `-${opts.groups.join('+')}` : '';
  const base = join(reports, `memory-eval-${opts.split}${groups}-${stamp}`);
  const meta = {
    generatedAt,
    split: opts.split,
    repeats: opts.repeats,
    models: opts.models,
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.groups ? { groups: opts.groups } : {}),
  };
  writeFileSync(`${base}.json`, JSON.stringify({ meta, results, observations }, null, 2));
  const md = renderMarkdown(meta, results);
  writeFileSync(`${base}.md`, md);
  process.stdout.write(md + `\nReport: ${base}.md\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
