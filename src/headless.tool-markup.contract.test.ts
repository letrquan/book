/**
 * A tool call the route left as markup in the reply's text, seen from a print run (#667).
 *
 * A supervised run reads the `result` record and the exit code, and both used to say the run
 * succeeded when its last reply was an unexecuted `<｜DSML｜ calls>` block.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printExitCode } from './cli/print-interrupt.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { isolateBookHome } from './test/isolated-book-home.js';
import {
  createRepeatingScriptedProvider,
  createScriptedProvider,
  sseResponse,
  type ScriptedProvider,
} from './test/scripted-provider.js';
import type { StreamJsonEvent } from './stream-json.js';
import type { AgentTerminalOutcome } from './types/terminal.js';

/** The scenario text of #667, as the issue wrote it. */
const DSML =
  '<｜DSML｜ calls>\n<｜DSML｜ invoke name="Grep">\n<｜DSML｜ parameter name="pattern" string="true">queue</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

let workspace: string;

isolateBookHome('book-markup-result-home-');

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-markup-result-workspace-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(workspace, { recursive: true, force: true });
});

const reply = (text: string): Response =>
  sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({
      id: 'response-1',
      model: 'gpt-5',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }),
  ]);

async function runStreamJson(provider: ScriptedProvider): Promise<{
  events: StreamJsonEvent[];
  outcome: AgentTerminalOutcome | undefined;
}> {
  vi.stubGlobal('fetch', provider.fetch);
  const writes: string[] = [];
  const result = await runHeadless(
    defaultConfig({ baseUrl: 'http://localhost/v1', workspace }),
    createDefaultRegistry(),
    {
      prompt: 'find queue',
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
    },
  );
  const events = writes
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StreamJsonEvent);
  return { events, outcome: result.outcome };
}

function resultEvent(events: StreamJsonEvent[]): Extract<StreamJsonEvent, { type: 'result' }> {
  const found = events.find((event) => event.type === 'result');
  expect(found).toBeDefined();
  return found as Extract<StreamJsonEvent, { type: 'result' }>;
}

describe('a reply that is tool-call markup, in print mode (#667)', () => {
  it('ends the run as malformed_tool_call, with no answer and a non-zero exit code', async () => {
    const provider = createRepeatingScriptedProvider(() => reply(DSML));

    const { events, outcome } = await runStreamJson(provider);
    const event = resultEvent(events);

    // The original and its one re-ask.
    expect(provider.requests).toHaveLength(2);
    expect(event.stopReason).toBe('malformed_tool_call');
    expect(event.outcome).toMatchObject({
      status: 'failed',
      reason: 'malformed_tool_call',
      partialOutput: false,
    });
    const result = event.result as { stopReason: string; answer: string; outcome: unknown };
    expect(result.stopReason).toBe('malformed_tool_call');
    expect(result.outcome).toEqual(event.outcome);
    // An unexecuted Grep is not the model's answer.
    expect(result.answer).toBe('');
    // Both replies are taken back from a reader that builds the transcript from the stream.
    expect(events.filter((candidate) => candidate.type === 'attempt_discarded')).toHaveLength(2);
    expect(events.filter((candidate) => candidate.type === 'error')).toHaveLength(1);
    expect(events.find((candidate) => candidate.type === 'error')).toMatchObject({
      error: expect.stringContaining('tool call written out as plain text'),
    });
    expect(printExitCode({ outcome, aborted: false })).toBe(1);
  });

  it('tells a stream-json reader the first attempt was taken back, and why', async () => {
    const provider = createScriptedProvider(reply(DSML), reply('The queue is FIFO.'));

    const { events } = await runStreamJson(provider);

    expect(events.find((event) => event.type === 'attempt_discarded')).toBeDefined();
    expect(events.find((event) => event.type === 'retry')).toMatchObject({
      phase: 'reissue',
      attempt: 1,
      max: 1,
      reason: 'malformed_tool_call',
    });
  });

  it('completes when the second reply is an answer', async () => {
    const provider = createScriptedProvider(reply(DSML), reply('The queue is FIFO.'));

    const { events, outcome } = await runStreamJson(provider);
    const event = resultEvent(events);

    expect(provider.requests).toHaveLength(2);
    expect(event.stopReason).toBe('normal_completion');
    expect(event.outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect((event.result as { answer: string }).answer).toBe('The queue is FIFO.');
    expect(printExitCode({ outcome, aborted: false })).toBe(0);
  });

  it('answers a reply that only mentions the tag on the first request', async () => {
    const text = 'Qwen wraps each call in `<tool_call>` tags.';
    const provider = createScriptedProvider(reply(text));

    const { events } = await runStreamJson(provider);
    const event = resultEvent(events);

    expect(provider.requests).toHaveLength(1);
    expect(event.stopReason).toBe('normal_completion');
    expect((event.result as { answer: string }).answer).toBe(text);
  });
});
