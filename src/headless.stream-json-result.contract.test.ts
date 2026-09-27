/**
 * The `result` event of the stream-json wire (#307).
 *
 * It is the only record a supervised print run gets to read the outcome from, so
 * `outcome` sits at the top level where `jq -e 'select(.type=="result") |
 * .outcome.reason=="objective_complete"'` reaches it, and the conversation is
 * left out by default: a long run's history is hundreds of kilobytes on a single
 * line that a reader must buffer whole.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { StreamJsonEvent } from './stream-json.js';

let workspace: string;
let tempHome: string;
let previousBookHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-sj-result-workspace-'));
  tempHome = mkdtempSync(join(tmpdir(), 'book-sj-result-home-'));
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = tempHome;
  const provider = createScriptedProvider(
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'objective complete' } }] }),
      JSON.stringify({
        id: 'response-1',
        model: 'gpt-5',
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }),
    ]),
  );
  vi.stubGlobal('fetch', provider.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  for (const dir of [workspace, tempHome]) rmSync(dir, { recursive: true, force: true });
});

async function runStreamJson(overrides: Record<string, unknown> = {}): Promise<StreamJsonEvent[]> {
  const writes: string[] = [];
  await runHeadless(
    defaultConfig({ baseUrl: 'http://localhost/v1', workspace }),
    createDefaultRegistry(),
    {
      prompt: 'do the objective',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout: {
        write: (line: string) => {
          writes.push(line);
          return true;
        },
      },
      ...overrides,
    },
  );
  return writes
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamJsonEvent);
}

function resultEvent(events: StreamJsonEvent[]): Extract<StreamJsonEvent, { type: 'result' }> {
  const found = events.find((event) => event.type === 'result');
  expect(found).toBeDefined();
  return found as Extract<StreamJsonEvent, { type: 'result' }>;
}

describe('stream-json result event (#307)', () => {
  it('carries the outcome at the top level, where the documented selector reads it', async () => {
    const events = await runStreamJson();
    const event = resultEvent(events);

    expect(Object.keys(event)).toEqual(expect.arrayContaining(['type', 'stopReason', 'outcome']));
    expect(event.outcome).toEqual({
      status: 'completed',
      reason: 'normal_completion',
      partialOutput: false,
    });
    // The selector docs/guide/long-runs.md evaluates on every line of the stream:
    //   jq -e 'select(.type=="result") | .outcome.reason=="objective_complete"'
    // reaches a `reason` string; before the fix `.outcome` was null there.
    const selected = events.filter((candidate) => candidate.type === 'result');
    expect(selected).toHaveLength(1);
    expect(selected.every((candidate) => typeof candidate.outcome?.reason === 'string')).toBe(true);
    expect(event.stopReason).toBe('normal_completion');
  });

  it('reports the same outcome at the top level and inside result', async () => {
    const event = resultEvent(await runStreamJson());
    const result = event.result as { outcome: unknown; stopReason: string; usage: unknown };

    expect(event.outcome).toEqual(result.outcome);
    expect(event.stopReason).toBe(result.stopReason);
    expect(result.usage).toMatchObject({ promptTokens: 12, completionTokens: 4, totalTokens: 16 });
  });

  it('leaves the message history out of the result event by default', async () => {
    const event = resultEvent(await runStreamJson());
    const result = event.result as Record<string, unknown>;

    expect(result.messages).toBeUndefined();
    // The answer and the accounting a supervisor reads are still there.
    expect(result.answer).toBe('objective complete');
    expect(result.accounting).toBeDefined();
  });

  it('includes the message history when the host asks for it', async () => {
    const event = resultEvent(await runStreamJson({ includeResultMessages: true }));
    const result = event.result as { messages: Array<{ role: string; content: string }> };

    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.map((message) => message.role)).toContain('assistant');
    expect(result.messages.at(-1)?.content).toBe('objective complete');
  });

  it('leaves the single-document json output carrying messages', async () => {
    const events = await runStreamJson({ outputFormat: 'json' });
    const document = events[0] as unknown as {
      result: { messages: unknown[]; outcome: { reason: string } };
    };

    expect(Array.isArray(document.result.messages)).toBe(true);
    expect(document.result.outcome.reason).toBe('normal_completion');
  });
});
