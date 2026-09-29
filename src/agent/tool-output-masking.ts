import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { toolResultSucceeded } from '../tools/result.js';
import { estimateTextTokens, toolResultRetrievalRef } from './compact.js';

/**
 * Tool-output masking: the cheap half of context management, run before any
 * summarizer (`plans/compaction-v3-plan.md` §1).
 *
 * The model stops reading an old, successful, re-derivable tool result: it
 * reads a one-line placeholder instead (`ToolResult.maskedPlaceholder`), which
 * keeps the tool name, its primary argument and how to get the output back.
 * The result's `content` stays whole, so the summarizer, the judge and the
 * record still have it; only the provider request is spared it.
 *
 * Measured basis: on SWE-bench Verified, masking the observations older than
 * the last ten turns matched LLM summarization at about half the cost, and
 * masking first with summarization as the last resort was cheapest ("The
 * Complexity Trap", arXiv 2508.21433). Masking a failed result raised error
 * rates (18.6% to 22.6%, arXiv 2606.00408), so failures are never masked.
 */

/** Tools whose output running the call again reproduces. Masked whenever they are old enough. */
const RERUNNABLE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'GitDiff',
  'GitLog',
  'GitStatus',
  'GitBranch',
  'SessionHistorySearch',
  'SessionHistoryRead',
]);

/**
 * Tools whose output running them again does not reproduce -- a command's output
 * depends on when it ran, a page changes -- so they are masked only when the
 * session records the output and the history tools can read it back.
 * `BashOutput` is in neither set: it returns only what is new since the last
 * read, so its output exists nowhere else in the conversation.
 */
const RECORDED_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch']);

/** What a placeholder starts with. */
export const MASKED_TOOL_OUTPUT_PREFIX = '[tool output cleared to save context';

/** A result this small costs about what its placeholder does. */
const MIN_MASKED_RESULT_TOKENS = 500;
/**
 * The newest steps with tool results are never masked, whatever they cost: the
 * newest is the wave the model has not seen yet, and the agent is still working
 * with the rest. Ten is the observation window "The Complexity Trap" tuned for
 * SWE-agent. On a small window this protects everything, and compaction does
 * the work instead -- which beats masking a file the agent read one step ago and
 * watching it read it again.
 */
const PROTECT_STEPS = 10;
/** Newest tool output never masked beyond those steps, and its share of the preflight gate. */
const PROTECT_MAX_TOKENS = 40_000;
const PROTECT_GATE_FRACTION = 0.2;
/**
 * Mask only when at least this much would go at once. Every mask rewrites an
 * earlier part of the prompt, so a provider's prefix cache is lost from there
 * on; batching keeps that rare (Anthropic's `clear_at_least`).
 */
const MIN_CLEAR_MAX_TOKENS = 20_000;
const MIN_CLEAR_GATE_FRACTION = 0.1;
/** The loop masks once the request passes this share of the preflight gate. */
export const MASK_GATE_FRACTION = 0.6;

export interface ToolOutputMaskOptions {
  /** Newest steps with tool results that are never masked (at least one). */
  protectSteps: number;
  /** Newest tool-result tokens that are never masked, beyond those steps. */
  protectTokens: number;
  /** The least a pass must clear; below it nothing is masked. */
  minClearTokens: number;
  /** Whether the session records tool output the history tools can read back. */
  recorded: boolean;
}

export interface ToolOutputMaskOutcome {
  history: Message[];
  maskedCount: number;
  /** Estimated tokens removed, net of the placeholders. */
  clearedTokens: number;
}

export function toolOutputMaskOptions(
  preflightThreshold: number,
  recorded: boolean,
): ToolOutputMaskOptions {
  return {
    protectSteps: PROTECT_STEPS,
    protectTokens: Math.min(
      PROTECT_MAX_TOKENS,
      Math.floor(preflightThreshold * PROTECT_GATE_FRACTION),
    ),
    minClearTokens: Math.max(
      1,
      Math.min(MIN_CLEAR_MAX_TOKENS, Math.floor(preflightThreshold * MIN_CLEAR_GATE_FRACTION)),
    ),
    recorded,
  };
}

function placeholder(
  message: Message,
  result: ToolResult,
  tool: string,
  subject: string,
  tokens: number,
  recorded: boolean,
): string {
  const ref = toolResultRetrievalRef(message, result);
  const again = RERUNNABLE_TOOLS.has(tool)
    ? recorded
      ? `run it again to see it, or read the recorded output at ${ref}`
      : 'run it again to see it'
    : `the recorded output is at ${ref}`;
  return `${MASKED_TOOL_OUTPUT_PREFIX}: ${subject} (~${tokens} tokens); ${again}]`;
}

/**
 * Mask old tool outputs in `history`. Returns the input array itself, untouched,
 * when the pass would clear less than `minClearTokens`; otherwise a new array in
 * which only the messages that changed are new objects.
 */
export function maskStaleToolOutputs(
  history: readonly Message[],
  options: ToolOutputMaskOptions,
): ToolOutputMaskOutcome {
  const placeholders = new Map<string, Map<string, string>>();
  let steps = 0;
  let protectedTokens = 0;
  let clearable = 0;
  let count = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message.includeInContext || !message.toolResults?.length) continue;
    steps++;
    for (let resultIndex = message.toolResults.length - 1; resultIndex >= 0; resultIndex--) {
      const result = message.toolResults[resultIndex];
      const tokens = estimateTextTokens(result.content);
      if (steps <= Math.max(1, options.protectSteps) || protectedTokens < options.protectTokens) {
        protectedTokens += tokens;
        continue;
      }
      if (tokens <= MIN_MASKED_RESULT_TOKENS) continue;
      if (!toolResultSucceeded(result) || result.maskedPlaceholder !== undefined) continue;
      const call = message.toolCalls?.find((item) => item.id === result.toolCallId);
      if (!call) continue;
      const tool = canonicalToolName(call.name);
      if (!RERUNNABLE_TOOLS.has(tool) && !(options.recorded && RECORDED_TOOLS.has(tool))) continue;
      const primary = getPrimaryArg(call.arguments ?? {});
      const text = placeholder(
        message,
        result,
        tool,
        `${tool}${primary ? ` ${primary}` : ''}`,
        tokens,
        options.recorded,
      );
      const byCall = placeholders.get(message.id) ?? new Map<string, string>();
      byCall.set(result.toolCallId, text);
      placeholders.set(message.id, byCall);
      clearable += tokens - estimateTextTokens(text);
      count++;
    }
  }
  if (count === 0 || clearable < options.minClearTokens) {
    return { history: history as Message[], maskedCount: 0, clearedTokens: 0 };
  }
  const masked = history.map((message) => {
    const byCall = placeholders.get(message.id);
    if (!byCall) return message;
    return {
      ...message,
      toolResults: message.toolResults!.map((result) => {
        const text = byCall.get(result.toolCallId);
        return text === undefined ? result : { ...result, maskedPlaceholder: text };
      }),
    };
  });
  return { history: masked, maskedCount: count, clearedTokens: clearable };
}
