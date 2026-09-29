import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { toolResultSucceeded } from '../tools/result.js';

/**
 * Tool-output masking: the cheap half of context management, run before any
 * summarizer (`plans/compaction-v3-plan.md` §1).
 *
 * The content of an old, successful, re-derivable tool result is replaced by a
 * one-line placeholder that keeps the tool name, its primary argument and a
 * reference the agent can read the exact output back from. The tool call and
 * its arguments stay, so paths and commands survive; the session record keeps
 * every byte, so nothing is lost -- only no longer re-sent on every request.
 *
 * Measured basis: on SWE-bench Verified, masking old observations matched LLM
 * summarization at about half the cost, and masking first with summarization
 * as the last resort was cheapest ("The Complexity Trap", arXiv 2508.21433).
 * Masking a failed result raised error rates (18.6% to 22.6%, arXiv
 * 2606.00408), so failures are never masked.
 */

/** Tools whose output can be read back or re-derived. Everything else keeps its result. */
const MASKABLE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'BashOutput',
  'WebFetch',
  'WebSearch',
  'GitDiff',
  'GitLog',
  'GitStatus',
  'GitBranch',
  'SessionHistorySearch',
  'SessionHistoryRead',
]);

/** What a masked result starts with, so a second pass leaves it alone. */
export const MASKED_TOOL_OUTPUT_PREFIX = '[tool output cleared to save context';

/** A result this small costs about what its placeholder does. */
const MIN_MASKED_RESULT_TOKENS = 500;
/** Newest tool output never masked, and its share of the preflight gate. */
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
  /** Newest tool-result tokens that are never masked. */
  protectTokens: number;
  /** The least a pass must clear; below it nothing is masked. */
  minClearTokens: number;
}

export interface ToolOutputMaskOutcome {
  history: Message[];
  maskedCount: number;
  /** Estimated tokens removed, net of the placeholders. */
  clearedTokens: number;
}

export function toolOutputMaskOptions(preflightThreshold: number): ToolOutputMaskOptions {
  return {
    protectTokens: Math.min(
      PROTECT_MAX_TOKENS,
      Math.floor(preflightThreshold * PROTECT_GATE_FRACTION),
    ),
    minClearTokens: Math.max(
      1,
      Math.min(MIN_CLEAR_MAX_TOKENS, Math.floor(preflightThreshold * MIN_CLEAR_GATE_FRACTION)),
    ),
  };
}

function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function isMaskedToolOutput(result: ToolResult): boolean {
  return result.content.startsWith(MASKED_TOOL_OUTPUT_PREFIX);
}

function placeholder(message: Message, result: ToolResult, tokens: number): string {
  const call = message.toolCalls?.find((item) => item.id === result.toolCallId);
  const primary = call ? getPrimaryArg(call.arguments ?? {}) : undefined;
  const subject = call ? `${call.name}${primary ? ` ${primary}` : ''}` : 'tool call';
  const ref =
    result.artifacts?.outputPath ??
    result.artifacts?.eventRef ??
    `session://current/tool-result/${message.id}/${result.toolCallId}`;
  return `${MASKED_TOOL_OUTPUT_PREFIX}: ${subject} (~${tokens} tokens); retrieve ${ref}]`;
}

/**
 * Mask old tool outputs in `history`, newest `protectTokens` of tool output
 * excepted. Returns the input array itself, untouched, when the pass would
 * clear less than `minClearTokens`; otherwise a new array in which only the
 * messages that changed are new objects.
 */
export function maskStaleToolOutputs(
  history: readonly Message[],
  options: ToolOutputMaskOptions,
): ToolOutputMaskOutcome {
  const candidates = new Map<string, Set<string>>();
  let protectedTokens = 0;
  let clearable = 0;
  let count = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (!message.includeInContext || !message.toolResults?.length) continue;
    for (let resultIndex = message.toolResults.length - 1; resultIndex >= 0; resultIndex--) {
      const result = message.toolResults[resultIndex];
      const tokens = estimateTokens(result.content);
      if (protectedTokens < options.protectTokens) {
        protectedTokens += tokens;
        continue;
      }
      if (tokens <= MIN_MASKED_RESULT_TOKENS) continue;
      if (!toolResultSucceeded(result) || isMaskedToolOutput(result)) continue;
      const call = message.toolCalls?.find((item) => item.id === result.toolCallId);
      if (!call || !MASKABLE_TOOLS.has(call.name)) continue;
      const ids = candidates.get(message.id) ?? new Set<string>();
      ids.add(result.toolCallId);
      candidates.set(message.id, ids);
      clearable += tokens - estimateTokens(placeholder(message, result, tokens));
      count++;
    }
  }
  if (count === 0 || clearable < options.minClearTokens) {
    return { history: history as Message[], maskedCount: 0, clearedTokens: 0 };
  }
  const masked = history.map((message) => {
    const ids = candidates.get(message.id);
    if (!ids) return message;
    return {
      ...message,
      toolResults: message.toolResults!.map((result) => {
        if (!ids.has(result.toolCallId)) return result;
        const content = placeholder(message, result, estimateTokens(result.content));
        return {
          ...result,
          content,
          presentation: result.presentation
            ? { ...result.presentation, details: content }
            : result.presentation,
        };
      }),
    };
  });
  return { history: masked, maskedCount: count, clearedTokens: clearable };
}
