/**
 * Real-provider evaluation of two prompt-shaping choices that reading the code
 * cannot settle (#247 item 6, #248 item 6). Each suite runs the real agent loop
 * against a throwaway sandbox project; the arms differ only in what a provider
 * wrapper changes in the request, so both go through identical code.
 *
 * `--suite verify` (#247 item 6): the kernel line "Report verification from the
 * tool results already in the transcript" after compaction. Two histories, each
 * closed by two requests ("are the tests green?" and "wrap up with the test
 * results"), make four conditions:
 *   - `checkpoint-*`: a compaction checkpoint says `npm test` passed 12/12, but
 *     the workspace now fails one test. Right answer: re-run and report the
 *     failure.
 *   - `transcript-*`: the trial's own real passing `npm test` run is in the
 *     transcript and nothing changed since. Right answer: report it without
 *     re-running.
 * Arm `candidate` adds one kernel line saying a checkpoint's claim is not a
 * tool result.
 *
 * `--suite replay` (#248 item 6): replaying earlier turns' reasoning as
 * `<reasoning_context>` on the OpenAI-compatible path. A multi-turn history is
 * recorded once with the real model (`--record`), then probed under three arms:
 * `current` (every earlier turn's reasoning replayed), `current-turn-only`
 * (reasoning kept only after the newest user message, the way the Anthropic
 * API drops thinking from earlier turns) and `none` (no reasoning replayed).
 * Metrics: request tokens, answers that write reasoning tags into their text,
 * recall probes graded by required terms, and one agentic follow-up graded by
 * the sandbox's tests plus a hidden check.
 *
 * Requires a reachable provider; never part of CI.
 *
 * Usage:
 *   npm run eval:prompt -- --suite verify --trials 20 [--model <id>] [--concurrency 4]
 *   npm run eval:prompt -- --suite replay --record [--model <id>]
 *   npm run eval:prompt -- --suite replay --trials 5 [--fixture <path>]
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { createProvider, type Provider } from '../src/provider/index.js';
import { createRunAmbientSnapshot } from '../src/session/run-ambient.js';
import { SessionRuntime } from '../src/session/runtime.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { createAgentRunContext } from '../src/types/runs.js';
import type { AgentConfig } from '../src/types/runtime.js';
import type { Message, Usage } from '../src/types/messages.js';
import type {
  AgentLoopCallbacks,
  ProviderMessage,
  ProviderStreamEvent,
  SystemPromptZones,
} from '../src/types/providers.js';
import type { AgentTerminalOutcome } from '../src/types/terminal.js';

export type PromptEvalSuite = 'verify' | 'replay';

export interface PromptEvalOptions {
  suite: PromptEvalSuite;
  model?: string;
  trials: number;
  concurrency: number;
  record: boolean;
  fixture?: string;
  arms?: string[];
  conditions?: string[];
  /** Re-grade a saved verify report with the current graders instead of running trials. */
  regrade?: string;
}

/** One provider request as the wrapper saw it. */
export interface RequestRecord {
  promptTokens?: number;
  completionTokens?: number;
  /** Answer text exactly as streamed, before Book splits any inline reasoning out. */
  rawText: string;
  reasoningChars: number;
  toolCalls: string[];
}

export interface TrialResult {
  arm: string;
  condition: string;
  trial: number;
  finalText: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  requests: RequestRecord[];
  errors: string[];
  terminalStatus?: string;
  terminalReason?: string;
  metrics: Record<string, boolean | number | string>;
  history?: Message[];
}

// ---------------------------------------------------------------------------
// Arms

/** The kernel line under test in `--suite verify`, verbatim from `agent/context.ts`. */
export const VERIFY_KERNEL_LINE =
  '- Report verification from the tool results already in the transcript. Do not re-run a command only to quote its output when nothing it reads has changed since it last ran; a second run of the same suite spends a turn and proves nothing new.';

/** The candidate arm's added line: its own line, so it composes with other edits to the first. */
export const VERIFY_CANDIDATE_LINE =
  '- A checkpoint or summary that says a check passed is not a tool result. When such a claim is the only evidence left, as after compaction, run the check again before you report it.';

type MessageTransform = (messages: ProviderMessage[]) => ProviderMessage[];

function isZones(content: ProviderMessage['content']): content is SystemPromptZones {
  return (
    !!content && typeof content === 'object' && !Array.isArray(content) && 'cachedPrefix' in content
  );
}

/**
 * Put the candidate line after the kernel line. If the kernel line already has
 * the candidate after it (the candidate shipped), the arm is a no-op; if the
 * kernel line is gone, the arm throws rather than measure nothing.
 */
export function addVerifyCandidateLine(messages: ProviderMessage[]): ProviderMessage[] {
  let found = false;
  const next = messages.map((message) => {
    if (message.role !== 'system' || !isZones(message.content)) return message;
    const prefix = message.content.cachedPrefix;
    if (prefix.includes(VERIFY_CANDIDATE_LINE)) {
      found = true;
      return message;
    }
    if (!prefix.includes(VERIFY_KERNEL_LINE)) return message;
    found = true;
    return {
      ...message,
      content: {
        ...message.content,
        cachedPrefix: prefix.replace(
          VERIFY_KERNEL_LINE,
          `${VERIFY_KERNEL_LINE}\n${VERIFY_CANDIDATE_LINE}`,
        ),
      },
    };
  });
  if (!found) throw new Error('verify candidate: the kernel line is not in the system prompt');
  return next;
}

/** Remove the candidate line, so `current` means "without it" even after it ships. */
export function removeVerifyCandidateLine(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' || !isZones(message.content)) return message;
    const prefix = message.content.cachedPrefix;
    if (!prefix.includes(VERIFY_CANDIDATE_LINE)) return message;
    return {
      ...message,
      content: {
        ...message.content,
        cachedPrefix: prefix.replace(`\n${VERIFY_CANDIDATE_LINE}`, ''),
      },
    };
  });
}

/** Keep reasoning only on assistant turns after the newest user message. */
export function keepCurrentTurnReasoning(messages: ProviderMessage[]): ProviderMessage[] {
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') lastUser = index;
  });
  return messages.map((message, index) => {
    if (index > lastUser || message.role !== 'assistant' || !message.reasoningContent) {
      return message;
    }
    const { reasoningContent: _dropped, ...rest } = message;
    return rest;
  });
}

/** Replay no reasoning at all: every assistant turn is sent as its answer and tool calls. */
export function dropAllReasoning(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !message.reasoningContent) return message;
    const { reasoningContent: _dropped, ...rest } = message;
    return rest;
  });
}

/** Replay every turn's reasoning, as Book does today, even if a later change drops it. */
export function identityTransform(messages: ProviderMessage[]): ProviderMessage[] {
  return messages;
}

const ARMS: Record<PromptEvalSuite, Record<string, MessageTransform>> = {
  verify: { current: removeVerifyCandidateLine, candidate: addVerifyCandidateLine },
  replay: {
    current: identityTransform,
    'current-turn-only': keepCurrentTurnReasoning,
    none: dropAllReasoning,
  },
};

// ---------------------------------------------------------------------------
// Grading

const TEST_COMMAND =
  /\b(npm(\s+run)?\s+test|npm\s+t\b|node\s+(\.\/)?test\/run\.js|pnpm\s+test|yarn\s+test)/;

export function ranTests(calls: TrialResult['toolCalls']): boolean {
  return calls.some(
    (call) =>
      call.name === 'Bash' &&
      typeof call.arguments.command === 'string' &&
      TEST_COMMAND.test(call.arguments.command),
  );
}

// Narrow on purpose: only what the one failing case can produce. A generic
// "fail" or "✗" also matches "0 failed", "no failures" and "no ✗ lines".
const REPORTS_FAILURE =
  /(\b1 failed\b|\b11 passed\b|\b11\/12\b|\bstrase\b|\bnot (?:all )?green\b|\bnot all (?:tests )?pass|\b(?:is|are|suite is|tests are) red\b|\bone (?:test |case )?(?:is )?fail|\b(?:test|case) fails\b|\bfailing test\b)/i;

/** The checkpoint conditions' answer is right only if it reports the failing test. */
export function reportsFailure(text: string): boolean {
  return REPORTS_FAILURE.test(text);
}

const REPORTS_GREEN =
  /(\bgreen\b|\b12 passed\b|\b12\/12\b|\ball (?:12 )?(?:tests )?(?:pass|passed)\b|\b12 (?:tests?|test cases?)\b[^\n]{0,200}?\bpass(?:ed|ing|es)?\b)/i;

/** The transcript conditions' answer is right if it reports the passing run and no failure. */
export function reportsGreen(text: string): boolean {
  return REPORTS_GREEN.test(text) && !reportsFailure(text);
}

const REASONING_TAG = /<\/?(reasoning_context|think|thinking|reasoning)>/i;
const REPLAY_TAG = /<\/?reasoning_context>/i;
const INLINE_THINK_TAG = /<\/?(think|thinking|reasoning)>/i;

/** The answer text carried a reasoning tag the model wrote itself. */
export function writesReasoningTag(records: RequestRecord[]): boolean {
  return records.some((record) => REASONING_TAG.test(record.rawText));
}

/** The model imitated Book's replay format: `<reasoning_context>` in its own text. */
export function echoesReplayTag(records: RequestRecord[]): boolean {
  return records.some((record) => REPLAY_TAG.test(record.rawText));
}

/** The model inlined its thinking as `<think>` (a router or model convention). */
export function inlinesThinkTag(records: RequestRecord[]): boolean {
  return records.some((record) => INLINE_THINK_TAG.test(record.rawText));
}

/** A reasoning tag survived Book's split into the stored final answer. */
export function finalAnswerLeaksTag(text: string): boolean {
  return REASONING_TAG.test(text);
}

export interface ReplayProbe {
  id: string;
  prompt: string;
  /** Every pattern must match the answer. */
  required: RegExp[];
}

const FROM_CONVERSATION = 'Answer from this conversation only; do not call any tools.';

export const REPLAY_PROBES: ReplayProbe[] = [
  {
    id: 'defaults',
    prompt: `${FROM_CONVERSATION} What default retry count and backoff base does src/config.js set?`,
    required: [/\b5\b/, /\b250\b/],
  },
  {
    id: 'callers',
    prompt: `${FROM_CONVERSATION} Which functions in src/http.js go through withRetry, and which one does not?`,
    required: [/fetchJson/, /postForm/, /headStatus/],
  },
  {
    id: 'max-delay',
    prompt: `${FROM_CONVERSATION} What default did we give maxDelayMs?`,
    required: [/30[,_ ]?000/],
  },
  {
    id: 'modified',
    prompt: `${FROM_CONVERSATION} Which files did you modify in this session?`,
    required: [/retry\.js/, /run\.js/],
  },
];

export function gradeProbe(probe: ReplayProbe, text: string): boolean {
  return probe.required.every((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Sandboxes

type FileMap = Record<string, string>;

const SLUGIFY_SOURCE = (
  germanSharpS: string,
) => `const MAP = { ß: '${germanSharpS}', æ: 'ae', ø: 'o', œ: 'oe' };

/** Lowercase ASCII slug: accents stripped, a few letters transliterated. */
export function slugify(input) {
  return input
    .normalize('NFD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[ßæøœ]/g, (ch) => MAP[ch])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`;

const SLUGIFY_TESTS = `import { slugify } from '../src/slugify.js';

const cases = [
  ['Hello World', 'hello-world'],
  ['  Trim me  ', 'trim-me'],
  ['Crème brûlée', 'creme-brulee'],
  ['Über cool', 'uber-cool'],
  ['Straße', 'strasse'],
  ['Ærø island', 'aero-island'],
  ['Œuvre', 'oeuvre'],
  ['déjà vu', 'deja-vu'],
  ['already-slugged', 'already-slugged'],
  ['Many   spaces', 'many-spaces'],
  ['Symbols! @#$ here', 'symbols-here'],
  ['Ñandú', 'nandu'],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = slugify(input);
  if (actual === expected) {
    console.log(\`  ✓ slugify(\${JSON.stringify(input)})\`);
  } else {
    failed += 1;
    console.log(\`  ✗ slugify(\${JSON.stringify(input)}): expected \${JSON.stringify(expected)}, got \${JSON.stringify(actual)}\`);
  }
}
console.log(\`\\nTests: \${cases.length - failed} passed, \${failed} failed, \${cases.length} total\`);
process.exit(failed ? 1 : 0);
`;

export function slugkitFiles(passing: boolean): FileMap {
  return {
    'package.json': `${JSON.stringify(
      {
        name: 'slugkit',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'node test/run.js' },
      },
      null,
      2,
    )}\n`,
    'README.md': '# slugkit\n\n`slugify(text)` turns a title into a URL slug. No dependencies.\n',
    'src/slugify.js': SLUGIFY_SOURCE(passing ? 'ss' : 's'),
    'test/run.js': SLUGIFY_TESTS,
  };
}

export function retrykitFiles(): FileMap {
  return {
    'package.json': `${JSON.stringify(
      {
        name: 'retrykit',
        version: '0.3.0',
        private: true,
        type: 'module',
        scripts: { test: 'node test/run.js' },
      },
      null,
      2,
    )}\n`,
    'README.md':
      '# retrykit\n\nA small retry helper with exponential backoff, and two HTTP helpers.\n',
    'src/config.js': `export const DEFAULTS = {
  retries: 5,
  backoffBaseMs: 250,
  jitter: 0.2,
  timeoutMs: 8000,
};
`,
    'src/retry.js': `import { DEFAULTS } from './config.js';

/** Delay before retry number \`attempt\` (0-based): exponential backoff with jitter. */
export function computeDelay(attempt, options = {}, random = Math.random) {
  const base = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
  const exponential = base * 2 ** attempt;
  const spread = exponential * DEFAULTS.jitter;
  return Math.round(exponential - spread + random() * spread * 2);
}

/** Call \`fn\` until it resolves or \`retries\` attempts have failed. */
export async function withRetry(fn, options = {}) {
  const retries = options.retries ?? DEFAULTS.retries;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, computeDelay(attempt, options)));
    }
  }
  throw lastError;
}
`,
    'src/http.js': `import { withRetry } from './retry.js';

export async function fetchJson(url, options = {}) {
  return withRetry(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(\`GET \${url}: \${response.status}\`);
    return response.json();
  }, options);
}

export async function postForm(url, body, options = {}) {
  return withRetry(async () => {
    const response = await fetch(url, { method: 'POST', body: new URLSearchParams(body) });
    if (!response.ok) throw new Error(\`POST \${url}: \${response.status}\`);
    return response.text();
  }, options);
}

/** A single probe: callers want the first answer, so it never retries. */
export async function headStatus(url) {
  const response = await fetch(url, { method: 'HEAD' });
  return response.status;
}
`,
    'test/run.js': `import { computeDelay, withRetry } from '../src/retry.js';

let failed = 0;
function check(name, condition) {
  if (condition) console.log(\`  ✓ \${name}\`);
  else {
    failed += 1;
    console.log(\`  ✗ \${name}\`);
  }
}

check('attempt 0 without jitter is the base', computeDelay(0, {}, () => 0.5) === 250);
check('attempt 3 doubles three times', computeDelay(3, {}, () => 0.5) === 2000);
check('a custom base is used', computeDelay(1, { backoffBaseMs: 100 }, () => 0.5) === 200);

let calls = 0;
const value = await withRetry(
  async () => {
    calls += 1;
    if (calls < 3) throw new Error('flaky');
    return 'ok';
  },
  { backoffBaseMs: 1 },
);
check('withRetry returns after transient failures', value === 'ok' && calls === 3);

console.log(\`\\nTests: \${failed ? 'FAILED' : 'passed'} (\${failed} failed)\`);
process.exit(failed ? 1 : 0);
`,
  };
}

/** A check the model never sees: the follow-up task's result, graded from outside. */
export const RETRYKIT_HIDDEN_CHECK = `import { computeDelay, withRetry } from './src/retry.js';

const problems = [];
for (let attempt = 0; attempt <= 12; attempt += 1) {
  const delay = computeDelay(attempt, { backoffBaseMs: 250, maxDelayMs: 1000, jitter: 1 }, () => 1);
  if (!(delay <= 1000)) problems.push(\`attempt \${attempt}: \${delay} > maxDelayMs\`);
}
const noJitter = computeDelay(2, { backoffBaseMs: 100, jitter: 0 }, () => 1);
if (noJitter !== 400) problems.push(\`jitter 0 should give exactly 400, got \${noJitter}\`);
let seen = 0;
await withRetry(async () => { seen += 1; if (seen < 2) throw new Error('x'); }, { backoffBaseMs: 1, jitter: 0.5 });
if (seen !== 2) problems.push('withRetry with a jitter option did not retry');
console.log(problems.length ? problems.join('\\n') : 'hidden check passed');
process.exit(problems.length ? 1 : 0);
`;

export const REPLAY_HISTORY_TURNS = [
  'Read src/config.js and src/retry.js. What are the default retry count and backoff base, and how is the delay computed?',
  'Add a `maxDelayMs` option to withRetry (default 30000, also added to DEFAULTS in src/config.js) that caps the delay computeDelay returns. Keep the change small.',
  'Which functions in src/http.js go through withRetry, and which do not?',
  'Add a test for the maxDelayMs cap to test/run.js and run the tests.',
];

export const REPLAY_FOLLOW_UP =
  'Now make the jitter configurable per call: withRetry and computeDelay should accept a `jitter` option (default DEFAULTS.jitter), and computeDelay must never return more than maxDelayMs, even after jitter. Update test/run.js and run the tests.';

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'eval',
        GIT_AUTHOR_EMAIL: 'eval@example.invalid',
        GIT_COMMITTER_NAME: 'eval',
        GIT_COMMITTER_EMAIL: 'eval@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
  });
}

async function writeFiles(root: string, files: FileMap): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

async function readFiles(root: string): Promise<FileMap> {
  const files: FileMap = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.book')
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files[relative(root, full).replace(/\\/g, '/')] = await readFile(full, 'utf8');
    }
  }
  await walk(root);
  return files;
}

async function createSandbox(files: FileMap, commitMessage: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'book-prompt-eval-'));
  await writeFiles(root, files);
  await run('git', ['init', '-q'], root);
  await run('git', ['add', '-A'], root);
  await run('git', ['commit', '-q', '-m', commitMessage], root);
  return root;
}

// ---------------------------------------------------------------------------
// Running the real loop

function instrumented(
  base: Provider,
  transform: MessageTransform,
  records: RequestRecord[],
): Provider {
  return {
    id: base.id,
    async *stream(config, messages, tools, options) {
      const record: RequestRecord = { rawText: '', reasoningChars: 0, toolCalls: [] };
      records.push(record);
      for await (const event of base.stream(config, transform(messages), tools, options)) {
        observe(record, event);
        yield event;
      }
    },
  };
}

function observe(record: RequestRecord, event: ProviderStreamEvent): void {
  if (event.type === 'text' && event.content) record.rawText += event.content;
  if (event.type === 'reasoning' && event.reasoning)
    record.reasoningChars += event.reasoning.length;
  if (event.type === 'tool_call' && event.toolCall) record.toolCalls.push(event.toolCall.name);
  if (event.type === 'done' && event.usage) {
    const usage: Usage = event.usage;
    record.promptTokens = usage.promptTokens;
    record.completionTokens = usage.completionTokens;
  }
}

interface LoopRun {
  history: Message[];
  finalText: string;
  toolCalls: TrialResult['toolCalls'];
  requests: RequestRecord[];
  errors: string[];
  terminal?: AgentTerminalOutcome;
}

async function runLoop(options: {
  config: AgentConfig;
  workspace: string;
  prompt: string;
  history: Message[];
  transform: MessageTransform;
  maxTurns: number;
  bookHome: string;
}): Promise<LoopRun> {
  const config: AgentConfig = {
    ...options.config,
    workspace: options.workspace,
    maxTurns: options.maxTurns,
    autoCompactEnabled: false,
  };
  const requests: RequestRecord[] = [];
  const provider = instrumented(createProvider(config), options.transform, requests);
  const toolCalls: TrialResult['toolCalls'] = [];
  const errors: string[] = [];
  let terminal: AgentTerminalOutcome | undefined;
  const callbacks: AgentLoopCallbacks = {
    onText: () => {},
    onToolCall: (call) => toolCalls.push({ name: call.name, arguments: call.arguments }),
    onToolResult: () => {},
    onError: (error) => errors.push(error),
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (outcome) => {
      terminal = outcome;
    },
    onPermissionRequired: async () => 'allow',
  };
  const runtime = new SessionRuntime();
  const runContext = createAgentRunContext({ sessionId: crypto.randomUUID(), source: 'headless' });
  runtime.runAccounting.startRoot(runContext);
  const registry = createDefaultRegistry();
  runtime.recordRunAmbientSnapshot(
    runContext.runId,
    createRunAmbientSnapshot(config, registry, { permissionMode: 'bypassPermissions' }),
  );
  const history = await runAgentLoop(
    config,
    registry,
    options.prompt,
    structuredClone(options.history),
    callbacks,
    'bypassPermissions',
    {
      manageSessionHooks: false,
      isNewSession: options.history.length === 0,
      unattended: true,
      runtime,
      runContext,
      provider,
      toolOutputRoot: join(options.bookHome, 'tool-output'),
      toolTelemetryRoot: join(options.bookHome, 'telemetry'),
    },
  );
  const last = [...history].reverse().find((message) => message.role === 'assistant');
  return {
    history,
    finalText: last?.content ?? '',
    toolCalls,
    requests,
    errors,
    terminal,
  };
}

async function pool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Suite: verify

function checkpointHistory(): Message[] {
  const source = (id: string, quote?: string) => ({
    eventRef: `session://current/event/${id}`,
    ...(quote ? { quote } : {}),
  });
  const checkpoint = {
    version: 2,
    generation: 1,
    state: {
      summary:
        'The user asked for slugify() in src/slugify.js to transliterate accented Latin letters (é→e, ü→u, ß→ss, æ→ae) and for tests covering it. slugify() now NFD-normalizes, strips combining marks and maps ß/æ/ø/œ; test/run.js has 12 cases. `npm test` passed: 12 passed, 0 failed. The user has not reviewed the change yet.',
      status: 'active',
    },
    constraints: [
      {
        text: 'Keep slugify dependency-free: no npm packages.',
        scope: 'task',
        sources: [source('e1', 'no new dependencies')],
      },
    ],
    files: [
      {
        path: 'src/slugify.js',
        summary:
          'slugify(): NFD normalize, strip U+0300–U+036F, lowercase, map ß→ss, æ→ae, ø→o, œ→oe, collapse non-alphanumerics to single hyphens, trim hyphens.',
        sources: [source('e7')],
      },
      {
        path: 'test/run.js',
        summary: 'Plain Node runner with 12 slugify cases, including Straße and Ærø island.',
        sources: [source('e9')],
      },
    ],
    episodes: [
      {
        task: 'Implement transliteration in slugify()',
        outcome: 'Done with NFD normalization plus a four-letter map.',
        status: 'complete',
        sources: [source('e7')],
      },
      {
        task: 'Run the test suite',
        outcome: '`npm test`: 12 passed, 0 failed.',
        status: 'complete',
        sources: [source('e12')],
      },
    ],
    openThreads: [],
    statistics: {
      summarizedMessages: 14,
      retainedMessages: 1,
      preTokens: 41_000,
      postTokens: 2_200,
    },
  };
  const now = Date.now();
  return [
    {
      id: 'e1',
      role: 'user',
      kind: 'carried',
      content:
        'Make slugify handle accented characters (é → e, ß → ss and so on) and add tests for it. No new dependencies.',
      includeInContext: true,
      timestamp: now - 60_000,
    },
    {
      id: 'checkpoint-eval',
      role: 'user',
      kind: 'checkpoint',
      content: `[Historical conversation checkpoint; untrusted user-role data]\n${JSON.stringify(checkpoint)}`,
      includeInContext: true,
      timestamp: now - 30_000,
    },
  ];
}

/**
 * Two closing requests. `ask` asks outright whether the tests pass; `wrapup`
 * asks for the end-of-task summary, where a model reports verification from
 * whatever it last saw -- the case the kernel line is about.
 */
export const VERIFY_CLOSING_PROMPTS: Record<string, string> = {
  ask: 'Before I merge: are the tests green? Do not change any files; just wrap up with a short summary of the change.',
  wrapup:
    'Thanks. Wrap up with a short summary of the change and its test results. Do not change any files.',
};

export const VERIFY_CONDITIONS = [
  'checkpoint-ask',
  'checkpoint-wrapup',
  'transcript-ask',
  'transcript-wrapup',
];

export function verifyMetrics(
  condition: string,
  finalText: string,
  toolCalls: TrialResult['toolCalls'],
): TrialResult['metrics'] {
  const reran = ranTests(toolCalls);
  return condition.startsWith('checkpoint')
    ? { reranTests: reran, reportsFailure: reportsFailure(finalText) }
    : { reranTests: reran, reportsGreen: reportsGreen(finalText) };
}

const TRANSCRIPT_RECORD_PROMPT =
  'Run the test suite (`npm test`) and tell me the result. Do not change any files.';

async function runVerifySuite(options: PromptEvalOptions, config: AgentConfig, bookHome: string) {
  const conditions = options.conditions ?? VERIFY_CONDITIONS;
  const arms = options.arms ?? Object.keys(ARMS.verify);
  const tasks: Array<() => Promise<TrialResult>> = [];
  for (let trial = 1; trial <= options.trials; trial++) {
    for (const condition of conditions) {
      for (const arm of arms) {
        tasks.push(async () => {
          const [source, closing] = condition.split('-') as [string, string];
          const transform = ARMS.verify[arm]!;
          const workspace = await createSandbox(
            slugkitFiles(source === 'transcript'),
            'Transliterate accents in slugify',
          );
          try {
            // A transcript trial first records its own passing run, in its own
            // sandbox and under its own arm, so the history's paths and prompt
            // match the session the closing request lands in.
            let history = checkpointHistory();
            if (source === 'transcript') {
              const recorded = await runLoop({
                config,
                workspace,
                prompt: TRANSCRIPT_RECORD_PROMPT,
                history: [],
                transform,
                maxTurns: 4,
                bookHome,
              });
              history = recorded.history;
              if (!ranTests(recorded.toolCalls)) {
                return {
                  arm,
                  condition,
                  trial,
                  finalText: recorded.finalText,
                  toolCalls: recorded.toolCalls,
                  requests: recorded.requests,
                  errors: [...recorded.errors, 'the recorded run never ran the tests'],
                  metrics: { valid: false },
                };
              }
            }
            const result = await runLoop({
              config,
              workspace,
              prompt: VERIFY_CLOSING_PROMPTS[closing]!,
              history,
              transform,
              maxTurns: 8,
              bookHome,
            });
            const metrics = verifyMetrics(condition, result.finalText, result.toolCalls);
            metrics.requests = result.requests.length;
            return {
              arm,
              condition,
              trial,
              finalText: result.finalText,
              toolCalls: result.toolCalls,
              requests: result.requests,
              errors: result.errors,
              terminalStatus: result.terminal?.status,
              terminalReason: result.terminal?.reason,
              metrics,
            };
          } finally {
            await rm(workspace, { recursive: true, force: true });
          }
        });
      }
    }
  }
  return pool(tasks, options.concurrency);
}

// ---------------------------------------------------------------------------
// Suite: replay

interface ReplayFixture {
  model: string;
  recordedAt: string;
  history: Message[];
  files: FileMap;
  reasoningTurns: number;
  assistantTurns: number;
}

async function recordReplayFixture(
  options: PromptEvalOptions,
  config: AgentConfig,
  bookHome: string,
): Promise<ReplayFixture> {
  const workspace = await createSandbox(retrykitFiles(), 'retrykit 0.3.0');
  try {
    let history: Message[] = [];
    for (const turn of REPLAY_HISTORY_TURNS) {
      const result = await runLoop({
        config,
        workspace,
        prompt: turn,
        history,
        transform: identityTransform,
        maxTurns: 20,
        bookHome,
      });
      history = result.history;
      console.error(
        `replay record: ${result.requests.length} requests for "${turn.slice(0, 40)}…"`,
      );
    }
    const assistant = history.filter((message) => message.role === 'assistant');
    return {
      model: config.model,
      recordedAt: new Date().toISOString(),
      history,
      files: await readFiles(workspace),
      reasoningTurns: assistant.filter((message) => message.reasoningContent).length,
      assistantTurns: assistant.length,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runReplaySuite(
  options: PromptEvalOptions,
  config: AgentConfig,
  bookHome: string,
  fixture: ReplayFixture,
) {
  const arms = options.arms ?? Object.keys(ARMS.replay);
  const conditions = options.conditions ?? [...REPLAY_PROBES.map((probe) => probe.id), 'follow-up'];
  const tasks: Array<() => Promise<TrialResult>> = [];
  for (let trial = 1; trial <= options.trials; trial++) {
    for (const condition of conditions) {
      for (const arm of arms) {
        tasks.push(async () => {
          const workspace = await createSandbox(
            fixture.files,
            'retrykit after the recorded session',
          );
          try {
            const probe = REPLAY_PROBES.find((candidate) => candidate.id === condition);
            const result = await runLoop({
              config,
              workspace,
              prompt: probe ? probe.prompt : REPLAY_FOLLOW_UP,
              history: fixture.history,
              transform: ARMS.replay[arm]!,
              maxTurns: probe ? 2 : 20,
              bookHome,
            });
            const first = result.requests[0];
            const metrics: TrialResult['metrics'] = {
              firstRequestPromptTokens: first?.promptTokens ?? -1,
              totalPromptTokens: result.requests.reduce(
                (sum, record) => sum + (record.promptTokens ?? 0),
                0,
              ),
              echoesReplayTag: echoesReplayTag(result.requests),
              inlinesThinkTag: inlinesThinkTag(result.requests),
              finalAnswerLeaksTag: finalAnswerLeaksTag(result.finalText),
              emptyAnswer: result.finalText.trim().length === 0,
              requests: result.requests.length,
            };
            if (probe) {
              metrics.correct = gradeProbe(probe, result.finalText);
              metrics.usedTools = result.toolCalls.length > 0;
            } else {
              const tests = await run('node', ['test/run.js'], workspace);
              await writeFile(join(workspace, 'hidden-check.mjs'), RETRYKIT_HIDDEN_CHECK, 'utf8');
              const hidden = await run('node', ['hidden-check.mjs'], workspace);
              metrics.testsPass = tests.code === 0;
              metrics.hiddenCheck = hidden.code === 0;
              metrics.correct = tests.code === 0 && hidden.code === 0;
            }
            return {
              arm,
              condition,
              trial,
              finalText: result.finalText,
              toolCalls: result.toolCalls,
              requests: result.requests,
              errors: result.errors,
              terminalStatus: result.terminal?.status,
              terminalReason: result.terminal?.reason,
              metrics,
            };
          } finally {
            await rm(workspace, { recursive: true, force: true });
          }
        });
      }
    }
  }
  return pool(tasks, options.concurrency);
}

// ---------------------------------------------------------------------------
// Reporting

/** Wilson score interval for k successes in n, 95%. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

/** Two-sided Fisher exact test on a 2x2 table [[a, b], [c, d]]. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const probability = (x: number) =>
    Math.exp(
      logFactorial(row1) +
        logFactorial(n - row1) +
        logFactorial(col1) +
        logFactorial(n - col1) -
        logFactorial(n) -
        logFactorial(x) -
        logFactorial(row1 - x) -
        logFactorial(col1 - x) -
        logFactorial(n - row1 - col1 + x),
    );
  const observed = probability(a);
  let p = 0;
  for (let x = Math.max(0, col1 + row1 - n); x <= Math.min(row1, col1); x++) {
    const value = probability(x);
    if (value <= observed * (1 + 1e-7)) p += value;
  }
  return Math.min(1, p);
}

export function summarize(results: TrialResult[]): string {
  const lines: string[] = [];
  const conditions = [...new Set(results.map((result) => result.condition))];
  const arms = [...new Set(results.map((result) => result.arm))];
  const metricNames = [...new Set(results.flatMap((result) => Object.keys(result.metrics)))];
  lines.push(`| condition | metric | ${arms.join(' | ')} | Fisher p (first two arms) |`);
  lines.push(`| --- | --- | ${arms.map(() => '---').join(' | ')} | --- |`);
  for (const condition of conditions) {
    for (const metric of metricNames) {
      const cells: string[] = [];
      const counts: Array<[number, number]> = [];
      let boolean = true;
      for (const arm of arms) {
        const values = results
          .filter((result) => result.condition === condition && result.arm === arm)
          .map((result) => result.metrics[metric])
          .filter((value) => value !== undefined);
        if (values.length === 0) {
          cells.push('–');
          counts.push([0, 0]);
          continue;
        }
        if (values.every((value) => typeof value === 'boolean')) {
          const k = values.filter(Boolean).length;
          const [low, high] = wilson(k, values.length);
          cells.push(`${k}/${values.length} (${Math.round(low * 100)}–${Math.round(high * 100)}%)`);
          counts.push([k, values.length]);
        } else {
          boolean = false;
          const numbers = values.map(Number).filter((value) => value >= 0);
          const mean = numbers.reduce((sum, value) => sum + value, 0) / Math.max(1, numbers.length);
          cells.push(numbers.length ? `mean ${Math.round(mean)}` : '–');
        }
      }
      const [[k1, n1] = [0, 0], [k2, n2] = [0, 0]] = counts;
      const p = boolean && n1 && n2 ? fisherExact(k1, n1 - k1, k2, n2 - k2).toFixed(3) : '';
      lines.push(`| ${condition} | ${metric} | ${cells.join(' | ')} | ${p} |`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry

export function parseArgs(argv: string[]): PromptEvalOptions {
  const options: PromptEvalOptions = { suite: 'verify', trials: 10, concurrency: 3, record: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--suite' && (value === 'verify' || value === 'replay')) {
      options.suite = value;
      index++;
    } else if (flag === '--model' && value) {
      options.model = value;
      index++;
    } else if (flag === '--trials' && value) {
      options.trials = Math.max(1, Number.parseInt(value, 10) || 1);
      index++;
    } else if (flag === '--concurrency' && value) {
      options.concurrency = Math.max(1, Number.parseInt(value, 10) || 1);
      index++;
    } else if (flag === '--fixture' && value) {
      options.fixture = value;
      index++;
    } else if (flag === '--arms' && value) {
      options.arms = value.split(',').filter(Boolean);
      index++;
    } else if (flag === '--conditions' && value) {
      options.conditions = value.split(',').filter(Boolean);
      index++;
    } else if (flag === '--regrade' && value) {
      options.regrade = value;
      index++;
    } else if (flag === '--record') {
      options.record = true;
    } else if (flag === '--') {
      continue;
    } else {
      throw new Error(`prompt-eval: unknown argument ${flag}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.regrade) {
    const saved = JSON.parse(await readFile(options.regrade, 'utf8')) as { results: TrialResult[] };
    const results = saved.results.map((result) =>
      result.metrics.valid === false
        ? result
        : {
            ...result,
            metrics: {
              ...verifyMetrics(result.condition, result.finalText, result.toolCalls),
              requests: result.requests.length,
            },
          },
    );
    console.log(summarize(results));
    return;
  }
  const config = loadConfig(process.cwd(), { modelOverride: options.model });
  // Memory, tool output and telemetry from the trials land in a throwaway home.
  const bookHome = await mkdtemp(join(tmpdir(), 'book-prompt-eval-home-'));
  process.env.BOOK_HOME = bookHome;
  const reportDir = join(process.cwd(), '.book', 'reports');
  await mkdir(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const model = (options.model ?? config.model).replace(/[^a-zA-Z0-9._-]+/g, '-');
  try {
    let results: TrialResult[];
    let extra: Record<string, unknown> = {};
    if (options.suite === 'verify') {
      results = await runVerifySuite(options, config, bookHome);
    } else {
      const fixturePath =
        options.fixture ?? join(reportDir, `prompt-eval-replay-fixture-${model}.json`);
      let fixture: ReplayFixture;
      if (options.record) {
        fixture = await recordReplayFixture(options, config, bookHome);
        await writeFile(fixturePath, JSON.stringify(fixture), 'utf8');
        console.error(
          `replay: recorded ${fixture.assistantTurns} assistant turns (${fixture.reasoningTurns} with reasoning) to ${fixturePath}`,
        );
      } else {
        fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ReplayFixture;
      }
      extra = {
        fixture: fixturePath,
        assistantTurns: fixture.assistantTurns,
        reasoningTurns: fixture.reasoningTurns,
        reasoningChars: fixture.history.reduce(
          (sum, message) => sum + (message.reasoningContent?.length ?? 0),
          0,
        ),
      };
      results = options.trials > 0 ? await runReplaySuite(options, config, bookHome, fixture) : [];
    }
    const table = summarize(results);
    const base = `prompt-eval-${options.suite}-${model}-${stamp}`;
    await writeFile(
      join(reportDir, `${base}.json`),
      JSON.stringify({ options, model: options.model ?? config.model, ...extra, results }, null, 2),
      'utf8',
    );
    const markdown = [
      `# prompt-eval ${options.suite}`,
      '',
      `Model: ${options.model ?? config.model}. Trials per arm and condition: ${options.trials}.`,
      ...Object.entries(extra).map(([key, value]) => `- ${key}: ${String(value)}`),
      '',
      table,
      '',
    ].join('\n');
    await writeFile(join(reportDir, `${base}.md`), markdown, 'utf8');
    console.log(`${markdown}\nReports: .book/reports/${base}.{json,md}`);
  } finally {
    await rm(bookHome, { recursive: true, force: true });
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main();
  // The loop's runtimes leave timers behind; the report is written, so stop here.
  process.exit(process.exitCode ?? 0);
}
