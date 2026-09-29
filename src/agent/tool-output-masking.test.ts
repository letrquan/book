import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import {
  MASKED_TOOL_OUTPUT_PREFIX,
  maskStaleToolOutputs,
  toolOutputMaskOptions,
} from './tool-output-masking.js';

/** One assistant step that called `tool` and got `tokens` worth of output back. */
function step(id: string, tool: string, tokens: number, failed = false): Message {
  const callId = `${id}-call`;
  const content = 'x'.repeat(tokens * 4);
  return {
    id,
    role: 'assistant',
    content: '',
    includeInContext: true,
    kind: 'conversation',
    timestamp: 0,
    toolCalls: [{ id: callId, name: tool, arguments: { path: `src/${id}.ts` } }],
    toolResults: [
      failed
        ? toolFailure('command failed', { toolCallId: callId, content })
        : toolSuccess(content, { toolCallId: callId }),
    ],
  };
}

const options = { protectTokens: 10_000, minClearTokens: 5_000 };

describe('maskStaleToolOutputs', () => {
  it('masks old re-derivable outputs past the protected recent budget', () => {
    const history = [
      step('a', 'Read', 4_000),
      step('b', 'Grep', 4_000),
      step('c', 'Read', 6_000),
      step('d', 'Read', 6_000),
    ];
    const outcome = maskStaleToolOutputs(history, options);
    expect(outcome.maskedCount).toBe(2);
    expect(outcome.history[0].toolResults![0].content).toMatch(
      new RegExp(
        `^\\${MASKED_TOOL_OUTPUT_PREFIX}: Read src/a\\.ts \\(~4000 tokens\\); retrieve session://current/tool-result/a/a-call\\]$`,
      ),
    );
    expect(outcome.history[1].toolResults![0].content.startsWith(MASKED_TOOL_OUTPUT_PREFIX)).toBe(
      true,
    );
    // The newest 10k of tool output is untouched, as the same objects.
    expect(outcome.history[2]).toBe(history[2]);
    expect(outcome.history[3]).toBe(history[3]);
    // The tool call itself survives, so the path does too.
    expect(outcome.history[0].toolCalls).toEqual(history[0].toolCalls);
  });

  it('changes nothing when a pass would clear less than the minimum', () => {
    const history = [step('a', 'Read', 3_000), step('b', 'Read', 12_000)];
    const outcome = maskStaleToolOutputs(history, options);
    expect(outcome.maskedCount).toBe(0);
    expect(outcome.history).toBe(history);
  });

  it('never masks a failed result, a small one, or a tool whose output cannot be re-derived', () => {
    const history = [
      step('fail', 'Bash', 8_000, true),
      step('small', 'Read', 400),
      step('ask', 'AskUserQuestion', 8_000),
      step('task', 'Task', 8_000),
      step('read', 'Read', 8_000),
      step('recent', 'Read', 12_000),
    ];
    const outcome = maskStaleToolOutputs(history, options);
    expect(outcome.maskedCount).toBe(1);
    const masked = outcome.history.filter((message) =>
      message.toolResults?.[0].content.startsWith(MASKED_TOOL_OUTPUT_PREFIX),
    );
    expect(masked.map((message) => message.id)).toEqual(['read']);
  });

  it('leaves an already-masked result alone on a second pass', () => {
    const history = [step('a', 'Read', 6_000), step('b', 'Read', 6_000), step('c', 'Read', 12_000)];
    const first = maskStaleToolOutputs(history, options);
    expect(first.maskedCount).toBe(2);
    const second = maskStaleToolOutputs(first.history, options);
    expect(second.maskedCount).toBe(0);
    expect(second.history).toBe(first.history);
  });

  it('prefers the spilled output file as the retrieval reference', () => {
    const message = step('a', 'Bash', 6_000);
    message.toolResults![0] = {
      ...message.toolResults![0],
      artifacts: { outputPath: '/home/u/.book/tool-output/a.txt' },
    };
    const outcome = maskStaleToolOutputs([message, step('b', 'Read', 12_000)], options);
    expect(outcome.history[0].toolResults![0].content).toContain(
      'retrieve /home/u/.book/tool-output/a.txt]',
    );
  });

  it('scales its budgets with the preflight gate', () => {
    expect(toolOutputMaskOptions(166_400)).toEqual({
      protectTokens: 33_280,
      minClearTokens: 16_640,
    });
    expect(toolOutputMaskOptions(1_000_000)).toEqual({
      protectTokens: 40_000,
      minClearTokens: 20_000,
    });
    expect(toolOutputMaskOptions(22_323)).toEqual({ protectTokens: 4_464, minClearTokens: 2_232 });
  });
});
