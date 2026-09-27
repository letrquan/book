/**
 * What a print-mode run writes to the session's `usage` records (#294).
 *
 * The record is the only durable statement of what a run spent: `RunAccounting`
 * is rebuilt with the process, so a restart restores the carry by summing these
 * records. A record that carries the restored total again inflates the carry
 * every restart, and a request whose usage is never recorded under-reports it —
 * either way `--max-budget-usd` stops bounding the objective it was set for.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { SessionStore } from './session/store.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';
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
});
