import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import {
  normalizeToolResult,
  toolFailure,
  toolResultModelContent,
  toolSuccess,
} from '../tools/result.js';
import { clipHistoryToolResults } from './compact.js';
import {
  MASKED_TOOL_OUTPUT_PREFIX,
  maskAtGate,
  maskBeforeCompacting,
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
      `${MASKED_TOOL_OUTPUT_PREFIX}: Read src/a-0.ts (~4000 tokens); run Read again to see its current output]`,
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
    const outcome = maskStaleToolOutputs(history, toolOutputMaskOptions(28_800));
    expect(outcome.maskedCount).toBe(0);
  });

  it('changes nothing when a pass would clear less than the minimum', () => {
    const history = [step('a', 'Read', 3_000), step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const outcome = maskStaleToolOutputs(history, options);
    expect(outcome.maskedCount).toBe(0);
    expect(outcome.history).toBe(history);
  });

  it('masks only output a rerun reproduces: never a failure, a small result, a command or a page', () => {
    const history = [
      step('fail', 'Read', 8_000, 1, true),
      step('small', 'Read', 400),
      step('ask', 'AskUserQuestion', 8_000),
      step('task', 'Task', 8_000),
      step('bash', 'Bash', 8_000),
      step('incremental', 'BashOutput', 8_000),
      step('web', 'WebFetch', 8_000),
      step('read', 'Read', 8_000),
      step('grep', 'grep', 8_000),
      step('recent1', 'Read', 6_000),
      step('recent2', 'Read', 6_000),
    ];
    expect(maskedIds(maskStaleToolOutputs(history, options).history)).toEqual(['read', 'grep']);
  });

  it('reads a legacy alias as the tool it names', () => {
    const history = [
      step('a', 'read_file', 8_000),
      step('recent1', 'Read', 6_000),
      step('recent2', 'Read', 6_000),
    ];
    const outcome = maskStaleToolOutputs(history, options);
    expect(maskedIds(outcome.history)).toEqual(['a']);
    expect(outcome.history[0].toolResults![0].maskedPlaceholder).toContain(
      ': Read src/a-0.ts (~8000 tokens); run Read again to see its current output]',
    );
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

  it('keeps its placeholder across a resume, which rebuilds every tool result', () => {
    const history = [step('a', 'Read', 8_000), step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const masked = maskStaleToolOutputs(history, options).history[0].toolResults![0];
    const restored = normalizeToolResult(JSON.parse(JSON.stringify(masked)) as ToolResult);
    expect(restored.maskedPlaceholder).toBe(masked.maskedPlaceholder);
    expect(restored.content).toBe(masked.content);
  });

  it('runs only past the masking line of the gate', () => {
    const history = [
      step('old', 'Read', 30_000),
      ...Array.from({ length: 10 }, (_, index) => step(`recent${index}`, 'Read', 4_000)),
    ];
    // 60% of a 166.4k gate is 99,840.
    expect(maskBeforeCompacting(history, 166_400, 99_839).maskedCount).toBe(0);
    expect(maskBeforeCompacting(history, 166_400, 99_840).maskedCount).toBe(1);
  });

  it('is clipped by the tail clip like any result, keeping the placeholder the model reads', () => {
    const history = [step('a', 'Read', 8_000), step('b', 'Read', 6_000), step('c', 'Read', 6_000)];
    const masked = maskStaleToolOutputs(history, options).history;
    const clipped = clipHistoryToolResults(masked, 500);
    const result: ToolResult = clipped[0].toolResults![0];
    expect(result.maskedPlaceholder).toBe(masked[0].toolResults![0].maskedPlaceholder);
    expect(result.content.length).toBeLessThan(2_100);
    expect(toolResultModelContent(result)).toBe(result.maskedPlaceholder);
  });

  it('measures its protected window in what is sent, so masked results do not use it up', () => {
    // Ten masked steps at the front of the protected window cost a placeholder
    // each, not the 8k they replaced: the unmasked read behind them is still
    // inside the 10k token window.
    const alreadyMasked = maskStaleToolOutputs(
      [
        ...Array.from({ length: 10 }, (_, index) => step(`m${index}`, 'Read', 8_000)),
        step('x1', 'Read', 6_000),
        step('x2', 'Read', 6_000),
      ],
      options,
    ).history.slice(0, 10);
    expect(alreadyMasked.every((message) => message.toolResults![0].maskedPlaceholder)).toBe(true);
    const history = [step('keep', 'Read', 6_000), ...alreadyMasked];
    const outcome = maskStaleToolOutputs(history, { ...options, protectSteps: 0 });
    expect(maskedIds(outcome.history).filter((id) => id === 'keep')).toEqual([]);
  });

  it('decides with the same arithmetic wherever it is asked, scaling what it clears by the drift', () => {
    const history = [
      step('old', 'Read', 30_000),
      ...Array.from({ length: 10 }, (_, index) => step(`recent${index}`, 'Read', 4_000)),
    ];
    const clearing = maskStaleToolOutputs(history, toolOutputMaskOptions(166_400)).clearedTokens;
    expect(maskAtGate(history, 166_400, 170_000, 166_400).underLine).toBe(
      170_000 - clearing < 166_400,
    );
    // At a drift of 1.2 the same pass is worth more on the provider's scale.
    const drifted = maskAtGate(history, 166_400, 190_000, 166_400, 1.2);
    expect(drifted.underLine).toBe(190_000 - clearing * 1.2 < 166_400);
    expect(maskAtGate(history, 166_400, 90_000, 80_000).maskedCount).toBe(0);
  });

  it('scales its budgets with the preflight gate', () => {
    expect(toolOutputMaskOptions(166_400)).toEqual({
      protectSteps: 10,
      protectTokens: 33_280,
      minClearTokens: 16_640,
    });
    expect(toolOutputMaskOptions(1_000_000)).toMatchObject({
      protectTokens: 40_000,
      minClearTokens: 20_000,
    });
  });
});
