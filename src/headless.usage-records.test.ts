/**
 * What a print-mode run writes to the session's `usage` records (#294).
 *
 * The record is the only durable statement of what a run spent: `RunAccounting`
 * is rebuilt with the process, so a restart restores the carry by summing these
 * records. A record that carries the restored total again inflates the carry
 * every restart, and a request whose usage is never recorded under-reports it —
 * either way `--max-budget-usd` stops bounding the objective it was set for.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { SessionStore } from './session/store.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import { RunAccounting } from './session/run-accounting.js';
import type { AgentConfig } from './types/runtime.js';
import type { AgentRunContext } from './types/runs.js';
import type { ProviderResponseMetadata } from './types/providers.js';
import type { Usage } from './types/messages.js';
import type { HeadlessOptions } from './types/public-sdk.js';

let workspace: string;
let tempHome: string;
let previousBookHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-usage-workspace-'));
  tempHome = mkdtempSync(join(tmpdir(), 'book-usage-home-'));
  previousBookHome = process.env.BOOK_HOME;
  // Nothing here may read the developer's own user-global settings.
  process.env.BOOK_HOME = tempHome;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  for (const dir of [workspace, tempHome]) rmSync(dir, { recursive: true, force: true });
});

function freshConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return defaultConfig({ baseUrl: 'http://localhost/v1', workspace, ...overrides });
}

/** The usage chunk every response in these tests ends with. */
function usageChunk(promptTokens: number, completionTokens: number, finish: string): string {
  return JSON.stringify({
    id: `response-${promptTokens}`,
    model: 'gpt-5',
    choices: [{ delta: {}, finish_reason: finish }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

/** One settled request: `text`, then the usage the provider reports for it. */
function settledTurn(text: string, promptTokens: number, completionTokens: number): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    usageChunk(promptTokens, completionTokens, 'stop'),
  ]);
}

/** One request that calls a tool, with the usage the provider reports for it. */
function toolCallTurn(id: string, promptTokens: number, completionTokens: number): Response {
  return sseResponse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name: 'TaskCreate', arguments: JSON.stringify({ subject: 'note' }) },
              },
            ],
          },
        },
      ],
    }),
    usageChunk(promptTokens, completionTokens, 'tool_calls'),
  ]);
}

/** The tokens the `usage` records of a session add up to, the way the store sums them. */
function persistedTotals(store: SessionStore, sessionId: string): Record<string, number> {
  const records = persistedRecords(store, sessionId);
  return {
    count: records.length,
    promptTokens: records.reduce((total, usage) => total + (usage.promptTokens ?? 0), 0),
    completionTokens: records.reduce((total, usage) => total + (usage.completionTokens ?? 0), 0),
    totalTokens: records.reduce((total, usage) => total + (usage.totalTokens ?? 0), 0),
  };
}

function persistedRecords(store: SessionStore, sessionId: string): Usage[] {
  return store
    .readRecords(sessionId)
    .filter((record) => record.type === 'usage')
    .map((record) => (record.data as { usage: Usage }).usage);
}

type Respond = () => Response;

/** A recorded request's metadata: the model a `usage` record is named after. */
function lateMeta(responseModel = 'gpt-5'): ProviderResponseMetadata {
  return {
    provider: 'openai-compatible',
    requestedModel: responseModel,
    responseModel,
    responseId: `response-late-${responseModel}`,
  } as unknown as ProviderResponseMetadata;
}

/**
 * A child execution under `root`, for spend a managed agent records.
 *
 * The real path runs the child inside a worktree, and in print mode the
 * completion it produces is delivered back through a parent turn whose own
 * `onUsage` would write the very record under test — so the child's request is
 * recorded on the session's own accounting under a child run context instead,
 * which is the one thing the manager does with it too.
 */
function childOf(root: AgentRunContext, runId = `${root.runId}-child`): AgentRunContext {
  return { ...root, runId, parentRunId: root.runId, startedAt: Date.now() };
}

/**
 * One process over the session store: a fresh run whose root is seeded from the
 * store's restored spend, the way `cli/run.ts` seeds a resumed print run.
 * Returns how many requests the provider served.
 */
async function runProcess(
  store: SessionStore,
  sessionId: string,
  respond: Respond,
  overrides: Partial<HeadlessOptions> = {},
): Promise<number> {
  const loaded = store.load(sessionId);
  const provider = createRepeatingScriptedProvider(respond);
  vi.stubGlobal('fetch', provider.fetch);
  await runHeadless(freshConfig(), createDefaultRegistry(), {
    prompt: 'say hi',
    inputFormat: 'text',
    outputFormat: 'text',
    history: loaded.contextHistory,
    transcript: loaded.transcript,
    compactBoundaries: loaded.compactBoundaries,
    plan: loaded.plan,
    carriedUsage: loaded.carriedUsage,
    carriedModels: loaded.carriedModels,
    sessionStore: store,
    sessionId,
    mode: 'bypassPermissions',
    stdout: { write: () => true },
    ...overrides,
  });
  return provider.requests.length;
}

describe('print-mode usage records across a resume (#294)', () => {
  it("persists each process's own requests once, never the carry it resumed from", async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    const sent: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [];

    // Three processes over one session, each making exactly one request and each
    // carrying the previous processes' persisted spend into its root.
    for (let process = 0; process < 3; process++) {
      const promptTokens = (process + 1) * 1_000;
      const completionTokens = (process + 1) * 100;
      const calls = await runProcess(
        store,
        sessionId,
        () => settledTurn(`answer ${process}`, promptTokens, completionTokens),
        { prompt: `turn ${process}` },
      );
      expect(calls).toBe(1);
      sent.push({
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
    }

    // Every request that was actually made, once — not the restored total written
    // again, and not a request whose usage never reached the store.
    expect(persistedRecords(store, sessionId)).toMatchObject(sent);
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 3,
      promptTokens: 6_000,
      completionTokens: 600,
      totalTokens: 6_600,
    });
  });

  it('persists the last request of a single run', async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    let turn = 0;

    // A tool call, then the answer. The snapshot the loop takes when it reports
    // usage never held the request being reported, so the last one was lost and
    // the first was written twice.
    const calls = await runProcess(store, sessionId, () => {
      turn++;
      return turn === 1 ? toolCallTurn('call-1', 1_000, 100) : settledTurn('all done', 7_000, 300);
    });

    expect(calls).toBe(2);
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      { promptTokens: 7_000, completionTokens: 300, totalTokens: 7_300 },
    ]);
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 2,
      promptTokens: 8_000,
      completionTokens: 400,
      totalTokens: 8_400,
    });
  });

  it('persists each stream-json prompt of one process, not the running total', async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    let turn = 0;
    const provider = createRepeatingScriptedProvider(() => {
      turn++;
      return settledTurn(`answer ${turn}`, turn * 1_000, turn * 100);
    });
    vi.stubGlobal('fetch', provider.fetch);

    // The second prompt's root is seeded with the first prompt's inclusive total,
    // which is exactly the figure the first prompt already wrote to disk.
    await runHeadless(freshConfig(), createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'text',
      history: [],
      stdin: Readable.from([
        `${JSON.stringify({ type: 'user', content: 'first' })}\n`,
        `${JSON.stringify({ type: 'user', content: 'second' })}\n`,
      ]),
      sessionStore: store,
      sessionId,
      mode: 'bypassPermissions',
      stdout: { write: () => true },
    });

    expect(provider.requests).toHaveLength(2);
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      { promptTokens: 2_000, completionTokens: 200, totalTokens: 2_200 },
    ]);
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 2,
      promptTokens: 3_000,
      completionTokens: 300,
      totalTokens: 3_300,
    });
  });

  it("writes the first prompt's late spend from the second prompt's first record", async () => {
    // The second prompt's root is seeded with the first root's inclusive total,
    // which is not all of it on disk: a background agent or a compaction judge can
    // spend after the root's last `onUsage`, and a continuation refused by the
    // budget gate is charged but never reported. Treating the whole carry as
    // already written skipped that remainder permanently — no record ever held it,
    // and no process restored it.
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    const LATE: Usage = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
    const lateMeta = {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-late-agent',
    } as unknown as ProviderResponseMetadata;

    // The accounting is owned by a runtime `runHeadless` builds for itself, so the
    // spy is how the test reaches the root the loop is charging.
    const record = vi.spyOn(RunAccounting.prototype, 'record');

    let turn = 0;
    const provider = createRepeatingScriptedProvider(() => {
      turn++;
      if (turn === 1) return toolCallTurn('call-1', 10, 1);
      if (turn === 2) return settledTurn('first answer', 100, 10);
      return settledTurn('second answer', 200, 20);
    });
    vi.stubGlobal('fetch', provider.fetch);

    let lateRecorded = false;
    await runHeadless(freshConfig(), createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'text',
      history: [],
      stdin: Readable.from([
        `${JSON.stringify({ type: 'user', content: 'first' })}\n`,
        `${JSON.stringify({ type: 'user', content: 'second' })}\n`,
      ]),
      sessionStore: store,
      sessionId,
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      onAgentEvent: (event) => {
        // The first prompt's terminal record: its last response has been reported,
        // and the carry for the next root has not been folded yet.
        if (event.type !== 'result' || lateRecorded) return;
        lateRecorded = true;
        const accounting = record.mock.instances.at(-1) as RunAccounting | undefined;
        const root = record.mock.calls.at(-1)?.[0];
        // A managed agent answering now: charged to root 1, long after root 1's
        // last `onUsage`, so no record of root 1's own can cover it.
        accounting?.record(root as AgentRunContext, LATE, lateMeta);
      },
    });

    expect(provider.requests).toHaveLength(3);
    expect(lateRecorded).toBe(true);
    // Root 2's first record carries root 1's unwritten remainder plus its own turn.
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      { promptTokens: 250, completionTokens: 25, totalTokens: 275 },
    ]);
    // Nothing the session spent is missing from the record set.
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 3,
      promptTokens: 360,
      completionTokens: 36,
      totalTokens: 396,
    });
  });
});

/** A reviewer agent's structured answer, the way a real review agent returns one. */
const REVIEWER_REPORT = JSON.stringify({
  verdict: 'recommend',
  findings: [
    {
      severity: 'major',
      category: 'correctness',
      file: 'a.ts',
      line: 1,
      summary: 'the exported constant changed meaning',
      evidence: 'export const value = 2;',
      failure: 'callers that branch on value === 1 stop matching',
      suggestedFix: 'introduce a new constant instead of changing this one',
      confidence: 92,
    },
  ],
});

/**
 * Spend that `RunAccounting` holds when no further response of its root will be
 * reported (#336).
 *
 * The `usage` record is the only durable statement of what a run cost, and the
 * `onUsage` seam is the only thing that wrote one. Anything charged after the
 * root's last response — a managed agent that answered, a `/review` whose root
 * model was never called, a compaction judge — reached no store at all: the
 * process ended with the spend in memory, a resumed session restored a carry
 * that did not include it, and `--max-budget-usd` re-authorised it.
 */
describe('print-mode usage records for spend after the root run ends (#336)', () => {
  it("persists a managed child's spend, and the resume's carry counts it once", async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    // A background managed agent answering behind the root's back: the root
    // reported its own response, then the child made its request against the
    // same root while the process was on its way out.
    const CHILD: Usage = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
    const record = vi.spyOn(RunAccounting.prototype, 'record');
    let charged = false;
    const provider = createRepeatingScriptedProvider(() => settledTurn('the answer', 1_000, 100));
    vi.stubGlobal('fetch', provider.fetch);

    await runHeadless(freshConfig(), createDefaultRegistry(), {
      prompt: 'delegate, then answer',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      sessionStore: store,
      sessionId,
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      onAgentEvent: (event) => {
        // The root's own result record: its last response is behind it, so a
        // request charged now is one no response of this root will report.
        if (event.type !== 'result' || charged) return;
        charged = true;
        const accounting = record.mock.instances.at(-1) as RunAccounting | undefined;
        const root = record.mock.calls.at(-1)?.[0];
        accounting?.record(childOf(root as AgentRunContext), CHILD, lateMeta());
      },
    });

    expect(provider.requests).toHaveLength(1);
    expect(charged).toBe(true);
    // The root's own request, then the child's — before any later process reads
    // the carry this session ends with.
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
    ]);

    // Resume the session: the carry the second process restores now includes the
    // child's spend, so its own request is written as its own delta and the
    // three served requests are the total — none of them counted twice.
    const resumed = await runProcess(store, sessionId, () =>
      settledTurn('the resumed answer', 2_000, 200),
    );
    expect(resumed).toBe(1);
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 1_000, completionTokens: 100, totalTokens: 1_100 },
      { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
      { promptTokens: 2_000, completionTokens: 200, totalTokens: 2_200 },
    ]);
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 3,
      promptTokens: 3_050,
      completionTokens: 305,
      totalTokens: 3_355,
    });
  });

  it("persists a host-run /review's reviewer requests, whose root model is never called", async () => {
    // A review resolves its target from the host's git workspace, so this one
    // needs a repository of its own rather than the flat temp directory.
    const repo = mkdtempSync(join(tmpdir(), 'book-usage-review-'));
    const home = mkdtempSync(join(tmpdir(), 'book-usage-review-home-'));
    const previousHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = home;
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'book-tests@example.invalid');
      git('config', 'user.name', 'Book Tests');
      writeFileSync(join(repo, 'a.ts'), 'export const value = 1;\n', 'utf8');
      git('add', '.');
      git('commit', '-qm', 'initial');
      writeFileSync(join(repo, 'a.ts'), 'export const value = 2;\n', 'utf8');

      const config = defaultConfig({ baseUrl: 'http://localhost/v1', workspace: repo });
      // Keep the throwaway agent state out of the developer's BOOK_HOME history.
      config.settings.agents.persist = false;
      config.settings.agents.telemetry = false;
      const store = new SessionStore(repo);
      const sessionId = store.create({ cwd: repo });
      const provider = createRepeatingScriptedProvider(() =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: REVIEWER_REPORT } }] }),
          usageChunk(30, 12, 'stop'),
        ]),
      );
      vi.stubGlobal('fetch', provider.fetch);

      await runHeadless(config, createDefaultRegistry({ agents: true }), {
        prompt: '/review',
        inputFormat: 'text',
        outputFormat: 'text',
        history: [],
        mode: 'default',
        maxTurns: 2,
        sessionStore: store,
        sessionId,
        stdout: { write: () => true },
      });

      // The host performed the command, so no response of the root was ever
      // reported and the reviewer agents' requests are all the spend there is.
      const requests = provider.requests.length;
      expect(requests).toBeGreaterThan(0);
      expect(persistedTotals(store, sessionId)).toEqual({
        count: 1,
        promptTokens: 30 * requests,
        completionTokens: 12 * requests,
        totalTokens: 42 * requests,
      });
    } finally {
      if (previousHome === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previousHome;
      for (const dir of [repo, home]) rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('writes one record when the end of the run and the dispose both flush the same root', async () => {
    const store = new SessionStore(workspace);
    const sessionId = store.create({ cwd: workspace });
    const CHILD: Usage = { promptTokens: 50, completionTokens: 5, totalTokens: 55 };
    const record = vi.spyOn(RunAccounting.prototype, 'record');
    let charged = false;
    const provider = createRepeatingScriptedProvider(() => toolCallTurn('call-1', 10, 1));
    vi.stubGlobal('fetch', provider.fetch);

    // One turn, ended by the turn limit while the tool is still running: the
    // child's request is charged after the root's last response and before the
    // run ends, so the flush at the end of the run is the only one that can
    // write it — and the session is disposed immediately afterwards.
    await runHeadless(freshConfig(), createDefaultRegistry(), {
      prompt: 'do one thing',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      sessionStore: store,
      sessionId,
      maxTurns: 1,
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      onAgentEvent: (event) => {
        if (event.type !== 'tool_result' || charged) return;
        charged = true;
        const accounting = record.mock.instances.at(-1) as RunAccounting | undefined;
        const root = record.mock.calls.at(-1)?.[0];
        accounting?.record(childOf(root as AgentRunContext), CHILD, lateMeta());
      },
    });

    expect(provider.requests).toHaveLength(1);
    expect(charged).toBe(true);
    // The root's own turn, then the child's — once. A second flush of the same
    // watermark would add a third record and overstate the objective.
    expect(persistedRecords(store, sessionId)).toMatchObject([
      { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
      { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
    ]);
    expect(persistedTotals(store, sessionId)).toEqual({
      count: 2,
      promptTokens: 60,
      completionTokens: 6,
      totalTokens: 66,
    });
  });
});
