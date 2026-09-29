import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import { toolFailure, toolResultModelContent, toolSuccess } from '../tools/result.js';
import { clipHistoryToolResults } from './compact.js';
import {
  MASKED_TOOL_OUTPUT_PREFIX,
  maskStaleToolOutputs,
  toolOutputMaskOptions,
  type ToolOutputMaskOptions,
} from './tool-output-masking.js';

/** One assistant step whose tool calls returned `tokens` worth of output each. */
function step(id: string, tool: string, tokens: number, count = 1, failed = false): Message {
  const calls = Array.from({ length: count }, (_, index) => ({
    id: `${id}-call-${index}`,
    name: tool,
    arguments: { file_path: `src/${id}-${index}.ts` },
  }));
  const content = 'x'.repeat(tokens * 4);
  return {
    id,
    role: 'assistant',
    content: '',
    includeInContext: true,
    kind: 'conversation',
    timestamp: 0,
    toolCalls: calls,
    toolResults: calls.map((call) =>
      failed
        ? toolFailure('command failed', { toolCallId: call.id, content })
        : toolSuccess(content, { toolCallId: call.id }),
    ),
  };
}

const options: ToolOutputMaskOptions = {
  protectSteps: 2,
  protectTokens: 10_000,
  minClearTokens: 5_000,
  recorded: true,
};

const maskedIds = (history: readonly Message[]): string[] =>
  history.flatMap((message) =>
    (message.toolResults ?? [])
      .filter((result) => result.maskedPlaceholder !== undefined)
      .map(() => message.id),
  );

describe('maskStaleToolOutputs', () => {
  it('masks old re-derivable outputs past the protected steps and tokens, keeping the content', () => {
    const history = [
      step('a', 'Read', 4_000),
      step('b', 'Grep', 4_000),
      step('c', 'Read', 6_000),
      step('d', 'Read', 3_000),
      step('e', 'Read', 3_000),
    ];
    const outcome = maskStaleToolOutputs(history, options);
    // e and d are the protected steps; c tops up the protected 10k; b and a go.
    expect(maskedIds(outcome.history)).toEqual(['a', 'b']);
    const result = outcome.history[0].toolResults![0];
    expect(result.maskedPlaceholder).toBe(
      `${MASKED_TOOL_OUTPUT_PREFIX}: Read src/a-0.ts (~4000 tokens); run it again to see it, or read the recorded output at session://current/tool-result/a/a-call-0]`,
    );
    // The model reads the placeholder; the summarizer and the record keep every byte.
    expect(toolResultModelContent(result)).toBe(result.maskedPlaceholder);
    expect(result.content).toHaveLength(16_000);
    // Untouched messages are the same objects, and the call survives on a masked one.
    expect(outcome.history.slice(2)).toEqual(history.slice(2));
    expect(outcome.history[2]).toBe(history[2]);
    expect(outcome.history[0].toolCalls).toEqual(history[0].toolCalls);
  });

  it('never masks the wave the model has not seen, however large', () => {
    // Five parallel reads of ~12.8k each: the newest step, whole, over every budget.
    const history = [step('wave', 'Read', 12_800, 5)];
    const outcome = maskStaleToolOutputs(history, { ...options, protectSteps: 0 });
    expect(outcome.maskedCount).toBe(0);
    expect(outcome.history).toBe(history);
  });

  it('keeps the recent steps the agent is working with, so a small window compacts instead of re-reading', () => {
    const history = [step('a', 'Read', 6_000), step('b', 'Read', 6_000)];
    const outcome = maskStaleToolOutputs(history, toolOutputMaskOptions(28_800, true));
    expect(outcome.maskedCount).toBe(0);
  });

  it('changes nothing when a pass would clear less than the minimum', () => {
    const history = [step('a', 'Read', 3_000), step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const outcome = maskStaleToolOutputs(history, options);
    expect(outcome.maskedCount).toBe(0);
    expect(outcome.history).toBe(history);
  });

  it('never masks a failure, a small result, or a tool whose output exists nowhere else', () => {
    const history = [
      step('fail', 'Bash', 8_000, 1, true),
      step('small', 'Read', 400),
      step('ask', 'AskUserQuestion', 8_000),
      step('task', 'Task', 8_000),
      step('incremental', 'BashOutput', 8_000),
      step('read', 'Read', 8_000),
      step('recent1', 'Read', 6_000),
      step('recent2', 'Read', 6_000),
    ];
    expect(maskedIds(maskStaleToolOutputs(history, options).history)).toEqual(['read']);
  });

  it('masks output a rerun would not reproduce only where the session records it', () => {
    const history = [
      step('bash', 'Bash', 8_000),
      step('web', 'WebFetch', 8_000),
      step('read', 'Read', 8_000),
      step('recent1', 'Read', 6_000),
      step('recent2', 'Read', 6_000),
    ];
    const recorded = maskStaleToolOutputs(history, options);
    expect(maskedIds(recorded.history)).toEqual(['bash', 'web', 'read']);
    expect(recorded.history[0].toolResults![0].maskedPlaceholder).toContain(
      '; the recorded output is at session://current/tool-result/bash/bash-call-0]',
    );
    const unrecorded = maskStaleToolOutputs(history, { ...options, recorded: false });
    expect(maskedIds(unrecorded.history)).toEqual(['read']);
    expect(unrecorded.history[2].toolResults![0].maskedPlaceholder).toMatch(
      /; run it again to see it\]$/,
    );
  });

  it('reads a legacy alias as the tool it names', () => {
    const history = [
      step('a', 'read_file', 8_000),
      step('b', 'bash', 8_000),
      step('recent1', 'Read', 6_000),
      step('recent2', 'Read', 6_000),
    ];
    const outcome = maskStaleToolOutputs(history, options);
    expect(maskedIds(outcome.history)).toEqual(['a', 'b']);
    expect(outcome.history[0].toolResults![0].maskedPlaceholder).toContain(': Read src/a-0.ts');
  });

  it('leaves an already-masked result alone on a second pass', () => {
    const history = [
      step('a', 'Read', 6_000),
      step('b', 'Read', 6_000),
      step('c', 'Read', 6_000),
      step('d', 'Read', 6_000),
    ];
    const first = maskStaleToolOutputs(history, options);
    expect(first.maskedCount).toBe(2);
    const second = maskStaleToolOutputs(first.history, options);
    expect(second.maskedCount).toBe(0);
    expect(second.history).toBe(first.history);
  });

  it('points at the spilled output file when there is one', () => {
    const message = step('a', 'Bash', 6_000);
    message.toolResults![0] = {
      ...message.toolResults![0],
      artifacts: { outputPath: '/home/u/.book/tool-output/a.txt' },
    };
    const history = [message, step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const outcome = maskStaleToolOutputs(history, { ...options, protectTokens: 0 });
    expect(outcome.history[0].toolResults![0].maskedPlaceholder).toContain(
      'the recorded output is at /home/u/.book/tool-output/a.txt]',
    );
  });

  it('is left alone by the tail clip, which it already undercuts', () => {
    const history = [step('a', 'Read', 8_000), step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const masked = maskStaleToolOutputs(history, options).history;
    const clipped = clipHistoryToolResults(masked, 500);
    expect(clipped[0]).toBe(masked[0]);
    const result: ToolResult = clipped[0].toolResults![0];
    expect(result.content).toHaveLength(32_000);
  });

  it('scales its budgets with the preflight gate', () => {
    expect(toolOutputMaskOptions(166_400, true)).toEqual({
      protectSteps: 10,
      protectTokens: 33_280,
      minClearTokens: 16_640,
      recorded: true,
    });
    expect(toolOutputMaskOptions(1_000_000, false)).toMatchObject({
      protectTokens: 40_000,
      minClearTokens: 20_000,
      recorded: false,
    });
  });
});
