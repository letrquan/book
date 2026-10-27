import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bookSettingsSchema } from '../src/settings.js';
import { defaultConfig } from '../src/test/fixtures.js';
import { createToolSurface } from '../src/tools/catalog.js';
import { routeTurnIntent } from '../src/tools/intent-routing.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { toolFailure, toolSuccess } from '../src/tools/result.js';
import type { Message } from '../src/types/messages.js';
import type { ToolCall, ToolResult } from '../src/types/tools.js';
import {
  armTaskFigures,
  estimateFromArgs,
  estimateModels,
  mockEvaluationSettings,
  mockSignatureFailures,
  parseToolEvalArgs,
  renderEstimate,
  seedWorkspace,
  trialCostUsd,
  TOOL_EVAL_ARMS,
  withArm,
  type ToolEvalArm,
  type ToolEvalOutcome,
} from './tool-discovery-eval.js';
import { cachedPrefixChars, mockReply, type ChatRequest } from './tool-discovery-eval-mock.js';
import { FETCH_CODENAME, TOOL_EVAL_TASKS } from './tool-discovery-eval-tasks.js';
import { runErrorOf, scoreToolEvalRun } from './tool-discovery-eval-worker.js';

const FIXTURE = { baseUrl: 'http://127.0.0.1:4000' };
const task = (name: string) => TOOL_EVAL_TASKS.find((candidate) => candidate.name === name)!;
const FETCH = task('fetch-url');

describe('arm selection', () => {
  /** The surface an arm's isolated settings give a run, read through the real settings schema. */
  function armSurface(arm: ToolEvalArm) {
    const settings = bookSettingsSchema.parse(
      withArm(mockEvaluationSettings('naive.fetch-url', 'http://127.0.0.1:9086/v1'), arm),
    );
    // The two keys an arm sets, as the schema read them from the run's settings.json.
    const config = defaultConfig();
    config.settings.toolDiscovery = settings.toolDiscovery;
    config.settings.hooks = settings.hooks;
    const context = {
      workspaceRoot: process.cwd(),
      // As the harness sets them for the worker, so WebFetch reaches the fixture server.
      env: { BOOK_WEB_ALLOW_HTTP: 'true', BOOK_WEB_ALLOW_PRIVATE_NETWORK: 'true' },
      currentMode: 'default' as const,
      backgroundShells: { nextId: 1, shells: new Map() },
    };
    const surface = createToolSurface({
      config,
      context,
      definitions: createDefaultRegistry().getDefinitions(),
    });
    const routed = routeTurnIntent(
      { typedText: FETCH.prompt(FIXTURE), config, context },
      surface,
    ).activated;
    return { surface, routed };
  }

  it.each<[ToolEvalArm, boolean, string[]]>([
    ['baseline', false, []],
    ['+direct', true, []],
    ['+routing', true, ['WebFetch']],
  ])('%s: direct calls %s, routing %j', (arm, direct, routed) => {
    const result = armSurface(arm);
    expect(result.surface.admitsDirectCalls?.()).toBe(direct);
    expect(result.routed).toEqual(routed);
  });

  it('keeps the base settings and merges toolDiscovery', () => {
    const merged = withArm(
      { toolDiscovery: { mode: 'deferred' }, agents: { mode: 'off' } },
      '+direct',
    );
    expect(merged).toEqual({
      toolDiscovery: { mode: 'deferred', intentRouting: false },
      agents: { mode: 'off' },
    });
  });

  it('parses the arm and task filters', () => {
    expect(parseToolEvalArgs([]).arms).toEqual([...TOOL_EVAL_ARMS]);
    expect(parseToolEvalArgs(['--arm', 'baseline,+routing']).arms).toEqual([
      'baseline',
      '+routing',
    ]);
    expect(parseToolEvalArgs(['--task', 'git-history']).tasks).toEqual(['git-history']);
    expect(() => parseToolEvalArgs(['--arm', 'names'])).toThrow('Unknown arm: names');
    expect(() => parseToolEvalArgs(['--mock', '--model', 'a/b'])).toThrow('--mock');
    expect(parseToolEvalArgs(['--rate', 'Muse Spark=0.5,2']).rates).toEqual({
      'Muse Spark': { in: 0.5, out: 2, cacheRead: undefined, cacheCreation: undefined },
    });
  });
});

let nextId = 0;
const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `call-${++nextId}`,
  name,
  arguments: args,
});
const turn = (calls: Array<[ToolCall, ToolResult]>, content = ''): Message => ({
  id: `turn-${++nextId}`,
  role: 'assistant',
  content,
  includeInContext: true,
  toolCalls: calls.map(([toolCall]) => toolCall),
  toolResults: calls.map(([toolCall, result]) => ({ ...result, toolCallId: toolCall.id })),
  timestamp: 0,
});
const user: Message = {
  id: 'user',
  role: 'user',
  content: 'go',
  includeInContext: true,
  timestamp: 0,
};

describe('metric extraction from a recorded run', () => {
  it('scores a refused direct call, then select:, then the call', () => {
    const fetch = call('WebFetch', { url: `${FIXTURE.baseUrl}/release-notes.txt` });
    const refused = toolFailure('Tool "WebFetch" is not active for this turn.', {
      code: 'tool_not_active',
      status: 'blocked',
    });
    const select = call('ToolSearch', { query: 'select:WebFetch' });
    const selected = toolSuccess('WebFetch: loaded', {
      data: { selections: [{ requested: 'WebFetch', name: 'WebFetch', status: 'loaded' }] },
    });
    const again = call('WebFetch', { url: `${FIXTURE.baseUrl}/release-notes.txt` });
    const messages = [
      user,
      turn([[fetch, refused]]),
      turn([[select, selected]]),
      turn([[again, toolSuccess(`codename ${FETCH_CODENAME}`)]]),
      turn([], `The codename is ${FETCH_CODENAME}.`),
    ];
    expect(
      scoreToolEvalRun(FETCH, messages, `The codename is ${FETCH_CODENAME}.`, () => null),
    ).toEqual({
      success: true,
      verified: true,
      firstCorrectCallTurn: 3,
      modelTurns: 4,
      fallbacks: 0,
      toolSearchMisses: 0,
      refusals: 1,
      unknownTools: 0,
    });
  });

  it('counts a ToolSearch miss, an unknown tool and a curl fallback; a host notice is no turn', () => {
    const search = call('ToolSearch', { query: 'download a page' });
    const miss = toolSuccess('No authorized deferred tools matched: download a page', {
      data: { query: 'download a page', matches: [], active: [] },
    });
    const unknown = call('Fetch', { url: 'x' });
    const curl = call('Bash', { command: `curl -s ${FIXTURE.baseUrl}/release-notes.txt` });
    const messages: Message[] = [
      user,
      turn([[search, miss]]),
      { ...turn([], 'host wrote this'), hostNotice: true },
      turn([[unknown, toolFailure('Unknown tool', { code: 'unknown_tool' })]]),
      turn([[curl, toolSuccess(`codename ${FETCH_CODENAME}`)]]),
      turn([], FETCH_CODENAME),
    ];
    expect(scoreToolEvalRun(FETCH, messages, FETCH_CODENAME, () => null)).toEqual({
      success: false,
      verified: true,
      modelTurns: 4,
      fallbacks: 1,
      toolSearchMisses: 1,
      refusals: 0,
      unknownTools: 1,
    });
  });

  it('verifies the notebook task from the file, not the answer', () => {
    const notebook = task('notebook-edit');
    const target = notebook.script.target(FIXTURE);
    const edit = call(target.name, target.arguments);
    const messages = [user, turn([[edit, toolSuccess('Replaced cell plot')]]), turn([], 'Done.')];
    // The weak model's hand-written notebook is the edited one.
    const edited = String(notebook.script.fallback(FIXTURE)[0].arguments.content);
    expect(scoreToolEvalRun(notebook, messages, 'Done.', () => edited).success).toBe(true);
    expect(
      scoreToolEvalRun(notebook, messages, 'Done.', () => notebook.files!['analysis.ipynb'])
        .verified,
    ).toBe(false);
  });
});

describe('the scripted models', () => {
  const declaring = (tools: string[], messages: ChatRequest['messages'] = []): ChatRequest => ({
    tools: tools.map((name) => ({ function: { name } })),
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }, ...messages],
  });
  const after = (name: string, output: string): ChatRequest['messages'] => [
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: output },
  ];

  it('decide from what the request declares', () => {
    const target = FETCH.script.target(FIXTURE);
    expect(mockReply('weak', FETCH, FIXTURE, declaring(['Read']))).toEqual({
      calls: FETCH.script.fallback(FIXTURE),
    });
    expect(mockReply('weak', FETCH, FIXTURE, declaring(['Read', 'WebFetch']))).toEqual({
      calls: [target],
    });
    expect(mockReply('naive', FETCH, FIXTURE, declaring(['Read']))).toEqual({ calls: [target] });
    expect(mockReply('searching', FETCH, FIXTURE, declaring(['Read']))).toEqual({
      calls: [{ name: 'ToolSearch', arguments: { query: FETCH.script.searchQuery } }],
    });
  });

  it('and from the last results', () => {
    expect(
      mockReply(
        'naive',
        FETCH,
        FIXTURE,
        declaring([], after('WebFetch', 'ERROR [tool_not_active]: no')),
      ),
    ).toEqual({ calls: [{ name: 'ToolSearch', arguments: { query: 'select:WebFetch' } }] });
    expect(
      mockReply(
        'searching',
        FETCH,
        FIXTURE,
        declaring([], after('ToolSearch', 'WebFetch [web] - Fetch')),
      ),
    ).toEqual({ calls: [FETCH.script.target(FIXTURE)] });
    expect(
      mockReply(
        'searching',
        FETCH,
        FIXTURE,
        declaring([], after('ToolSearch', 'No authorized deferred tools matched: x')),
      ),
    ).toEqual({ calls: FETCH.script.fallback(FIXTURE) });
    expect(
      mockReply(
        'naive',
        FETCH,
        FIXTURE,
        declaring([], after('WebFetch', `codename ${FETCH_CODENAME}`)),
      ),
    ).toEqual({ text: `The codename is ${FETCH_CODENAME}.` });
  });

  it('read back only the leading segments the previous request sent unchanged', () => {
    expect(cachedPrefixChars(undefined, ['tools', 'system'])).toBe(0);
    expect(cachedPrefixChars(['tools', 'system'], ['tools', 'system', 'user'])).toBe(11);
    // An activation changes the tools array, the first segment: nothing is read.
    expect(cachedPrefixChars(['tools', 'system'], ['tools+1', 'system', 'user'])).toBe(0);
  });
});

/** A mock outcome as the harness records it, with its first correct call and usage. */
function outcome(
  model: string,
  arm: ToolEvalArm,
  taskName: string,
  firstCorrectCallTurn: number | undefined,
  usage = { inputTokens: 20_000, cacheReadTokens: 8_000, cacheWriteTokens: 0, outputTokens: 50 },
): ToolEvalOutcome {
  const naiveBaseline = model === 'naive' && arm === 'baseline';
  return {
    task: taskName,
    target: task(taskName).target,
    arm,
    model,
    trial: 1,
    anthropic: false,
    success: firstCorrectCallTurn !== undefined,
    verified: true,
    firstCorrectCallTurn,
    modelTurns: (firstCorrectCallTurn ?? 1) + 1,
    fallbacks: firstCorrectCallTurn === undefined ? 1 : 0,
    toolSearchMisses: 0,
    refusals: naiveBaseline ? 1 : 0,
    unknownTools: 0,
    usage,
    durationMs: 1,
  };
}

describe('the mock signature check', () => {
  it('passes the outcomes each arm must produce', () => {
    const outcomes = [
      outcome('naive', 'baseline', 'git-history', 3),
      outcome('naive', '+direct', 'git-history', 1),
      outcome('searching', '+direct', 'fetch-url', 2),
      outcome('searching', '+routing', 'fetch-url', 1),
      outcome('weak', '+direct', 'fetch-url', undefined),
      outcome('weak', '+routing', 'fetch-url', 1),
      outcome('weak', '+routing', 'git-history', undefined),
    ];
    expect(mockSignatureFailures(outcomes)).toEqual([]);
  });

  it('flags an arm that does not do what it claims', () => {
    // A just-in-time call that did not run: the naive model went through select: again.
    expect(mockSignatureFailures([outcome('naive', '+direct', 'fetch-url', 3)])).toEqual([
      'naive / +direct / fetch-url: first correct call at turn 3, expected 1',
    ]);
    // Routing that did not declare the tool: the weak model fell back to curl.
    expect(mockSignatureFailures([outcome('weak', '+routing', 'fetch-url', undefined)])).toEqual([
      'weak / +routing / fetch-url: first correct call at turn never, expected 1',
      'weak / +routing / fetch-url: success false, expected true',
      'weak / +routing / fetch-url: 1 fallbacks',
    ]);
  });
});

describe('the estimate', () => {
  const anthropic = {
    label: 'Opus',
    anthropic: true,
    rate: { in: 4, out: 20, cacheRead: 0.2, cacheCreation: 5 },
  };
  const other = { label: 'Other', anthropic: false, rate: { in: 1, out: 2 } };
  const figure = { task: 'fetch-url', requests: 2, inputTokens: 20_000, cacheReadTokens: 8_000 };

  it('prices each request: Anthropic reads the cache and writes the rest', () => {
    // A request: 6,000 written at $5, 4,000 read at $0.20, 400 out at $20 per million.
    expect(trialCostUsd([figure], anthropic, 400)).toBeCloseTo(2 * 0.0388, 10);
  });

  it('prices another route with no cache, an upper bound', () => {
    // A request: 10,000 in at $1 and 400 out at $2 per million.
    expect(trialCostUsd([figure], other, 400)).toBeCloseTo(2 * 0.0108, 10);
  });

  it('has no figure without a rate', () => {
    expect(trialCostUsd([figure], { label: 'x', anthropic: false }, 400)).toBeUndefined();
  });

  it("picks a tiered rate by one request's prompt, not the task's sum", () => {
    const [haiku] = estimateModels(['anthropic/claude-haiku-5-5'], {});
    expect(haiku.anthropic).toBe(true);
    const large = { task: 'fetch-url', requests: 3, inputTokens: 240_000, cacheReadTokens: 0 };
    // 80,000 a request stays under the 100,000-token tier: written at $0.125, out at $0.50.
    expect(trialCostUsd([large], haiku, 400)).toBeCloseTo(
      (3 * (80_000 * 0.125 + 400 * 0.5)) / 1e6,
      10,
    );
  });

  it('takes the scripted run that sent the most on each task and arm', () => {
    const figures = armTaskFigures([
      outcome('weak', '+direct', 'fetch-url', undefined),
      outcome('naive', '+direct', 'fetch-url', 1, {
        inputTokens: 30_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 50,
      }),
    ]);
    expect(figures.get('+direct')).toEqual([
      { task: 'fetch-url', requests: 2, inputTokens: 30_000, cacheReadTokens: 0 },
    ]);
  });

  it('totals one full run at three trials and names the unpriced models', () => {
    const outcomes = TOOL_EVAL_ARMS.map((arm) => outcome('naive', arm, 'fetch-url', 1));
    const models = [other, { label: 'Unpriced', anthropic: false }];
    const table = renderEstimate(outcomes, models, 400);
    // Each arm's trial: two requests of 10,000 in and 400 out at $1/$2 per million = $0.0216.
    expect(table).toContain('| Other | $0.02 | $0.02 | $0.02 | $0.19 |');
    expect(table).toContain('| Unpriced | no rate | no rate | no rate | no rate |');
    expect(table).toContain('**$0.19**, not counting Unpriced');
  });
});

describe('seeding a task workspace', () => {
  let workspace = '';
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it('commits with a fixed identity and signing off', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'book-tool-eval-seed-'));
    const commands: string[][] = [];
    await seedWorkspace(task('git-history'), workspace, async (_command, args) => {
      commands.push(args);
      return 0;
    });
    const commits = commands.filter((args) => args.includes('commit'));
    expect(commits).toHaveLength(3);
    for (const args of commits) {
      expect(args).toEqual(
        expect.arrayContaining([
          '-c',
          'commit.gpgsign=false',
          'user.email=eval@book',
          'user.name=book-eval',
        ]),
      );
    }
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toContain('HTTP client');
  });

  it('fails loudly when a git command fails', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'book-tool-eval-seed-'));
    await expect(
      seedWorkspace(task('git-history'), workspace, async (_command, args) =>
        args.includes('commit') ? 128 : 0,
      ),
    ).rejects.toThrow(/git .*commit.* exited with 128/);
  });
});

describe('the estimate options', () => {
  it('prices the --trials it was given', () => {
    const outcomes = TOOL_EVAL_ARMS.map((arm) => outcome('naive', arm, 'fetch-url', 1));
    const table = estimateFromArgs(
      parseToolEvalArgs(['--estimate', '--trials', '5', '--model', 'openai/gpt-5']),
      outcomes,
    );
    expect(table).toContain('5 trials, all arms');
    expect(table).toContain('× 5 trials');
  });

  it.each(['abc', '0', '-3', '1.5'])('refuses --output-tokens %s', (value) => {
    expect(() => parseToolEvalArgs(['--output-tokens', value])).toThrow('--output-tokens');
  });
});

describe('a run error', () => {
  const eligibility = (eligible: boolean) => ({
    eligible,
    reasons: eligible ? [] : ['accounting_missing'],
  });

  it('keeps both the ineligibility and the outcome', () => {
    expect(runErrorOf(eligibility(false), { status: 'failed', reason: 'provider_error' })).toBe(
      'ineligible evaluation evidence: accounting_missing; failed: provider_error',
    );
  });

  it('is absent for an eligible, completed run', () => {
    expect(
      runErrorOf(eligibility(true), { status: 'completed', reason: 'normal_completion' }),
    ).toBeUndefined();
  });
});
