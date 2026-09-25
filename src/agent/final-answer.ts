import type { Message } from '../types/messages.js';

/**
 * The run's answer: the text of its final turn, and never an earlier turn's.
 *
 * The final turn answered only when the history ends with an assistant message
 * that called no tools. Any other ending means the model stopped before it
 * answered, so the answer is empty rather than an older turn's narration
 * (#248). The supported shapes, pinned by `final-answer.test.ts`:
 *
 * - An assistant turn with no tool calls (an answer, or a failed turn's partial
 *   text): its text.
 * - A failed final turn that was only reasoning, recorded with empty content: `''`.
 * - A turn that called tools, because a failure recorded nothing after it, the
 *   run hit max turns, or it was cancelled inside a tool: `''`.
 * - A user message nothing answered: `''`.
 * - An empty history: `''`.
 */
export function finalAnswerText(history: readonly Message[]): string {
  const last = history.at(-1);
  if (!last || last.role !== 'assistant' || (last.toolCalls?.length ?? 0) > 0) return '';
  return last.content;
}
