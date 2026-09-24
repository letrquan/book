/**
 * `npm run eval:memory` — does memory make the next session better, and does it stay safe?
 * Design: plans/memory-improvement-plan.md, "Evaluation". Needs `npm run build` and a working
 * provider in ~/.book/settings.json; each run is a real, billed conversation.
 *
 *   npm run eval:memory -- [--models a,b] [--split test|dev|all] [--repeats 3]
 *                          [--only id1,id2] [--concurrency 2] [--timeout-ms 300000]
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

export const DEFAULT_MODELS = [
  '9router/ag/gemini-3.8-flash-high',
  '9router/cx/gpt-5.6-luna',
  '9router/cc/claude-sonnet-5',
  '9router/cmc/deepseek/deepseek-v4.1-flash',
];

export interface MemoryEvalOptions {
  models: string[];
  split: 'dev' | 'test' | 'all';
  repeats: number;
  only?: string[];
  concurrency: number;
  timeoutMs: number;
}

export function parseArgs(argv: string[]): MemoryEvalOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const split = (get('--split') ?? 'test') as MemoryEvalOptions['split'];
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
    concurrency: int('--concurrency', 2),
    timeoutMs: int('--timeout-ms', 300_000),
  };
}

export function selectScenarios(opts: Pick<MemoryEvalOptions, 'split' | 'only'>): MemoryScenario[] {
  return MEMORY_SCENARIOS.filter(
    (s) =>
      (opts.split === 'all' || s.split === opts.split) && (!opts.only || opts.only.includes(s.id)),
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

/** One `book --print` conversation turn; `resume` continues the workspace's latest session. */
async function session(
  model: string,
  prompt: string,
  ws: string,
  home: string,
  resume: boolean,
  timeoutMs: number,
): Promise<SessionResult> {
  const args = [CLI, '--print', '--model', model, '--permission-mode', 'bypassPermissions'];
  args.push('--output-format', 'stream-json');
  if (resume) args.push('--continue');
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
          const body = event.result as {
            messages?: Array<{ role: string; content?: string }>;
            usage?: { promptTokens?: number };
          };
          const last = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
          result.text = last?.content ?? '';
          result.inputTokens = body?.usage?.promptTokens ?? 0;
        }
      }
      if (!sawResult) {
        reject(new Error(`session exited ${code} without a result: ${err.trim().slice(-300)}`));
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
    writeFiles(ws, BASE_WORKSPACE);
    const git = (...args: string[]) => run('git', ['-C', ws, ...args]);
    await git('init', '-q');
    await git('add', '-A');
    await git('-c', 'user.email=eval@book', '-c', 'user.name=eval', 'commit', '-qm', 'base');

    // The baseline has no memory, so nothing a teaching session did could reach its probe.
    if (arm === 'memory') {
      writeFiles(ws, scenario.teachFiles ?? {});
      for (const [i, turn] of scenario.teach.entries()) {
        const taught = await session(
          model,
          turn.replaceAll('{{WEB}}', webUrl),
          ws,
          home,
          i > 0,
          opts.timeoutMs,
        );
        obs.teachTools.push(...taught.tools);
      }
      await git('reset', '--hard', '-q');
      await git('clean', '-fdxq');
      Object.assign(obs, readStore(home));
    }

    const probe = await session(model, scenario.probe, ws, home, false, opts.timeoutMs);
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
  const base = join(reports, `memory-eval-${opts.split}-${stamp}`);
  const meta = { generatedAt, split: opts.split, repeats: opts.repeats, models: opts.models };
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
