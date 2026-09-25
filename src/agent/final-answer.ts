import type { Message } from '../types/messages.js';

/**
 * The run's answer: the model's final answer, and never an earlier turn's narration.
 *
 * Walking back from the end of the history, two kinds of message are passed over,
 * because neither ends an answer:
 * - a user-role message the host wrote itself (`derivedContent`): the
 *   `[continuation]` and completion-gate prompts, the output-cap resume, and the
 *   `[work-state]` refresh the loop appends mid-run;
 * - an assistant turn with no text and no tool calls, such as a failed turn that
 *   was only reasoning.
 *
 * The first other message decides. An assistant turn that called no tools is the
 * answer. Anything else (a turn that called tools, or a message the user wrote)
 * means the model stopped before it answered again, so the answer is empty rather
 * than an older turn's narration (#248).
 *
 * `openingMessageId` bounds the walk to one run: it is the id of the message that
 * opened the run, and reaching it means the run recorded no answer. That prompt can
 * be host-written itself (every managed child's task is), and without the bound the
 * walk would pass over it into the previous run's answer. When compaction replaced
 * the opening message, the walk stops at the checkpoint instead, a user message the
 * host does not mark derived. The supported shapes are pinned by
 * `final-answer.test.ts`.
 */
export function finalAnswerText(history: readonly Message[], openingMessageId?: string): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.id === openingMessageId) return '';
    if (message.role === 'user') {
      if (message.derivedContent) continue;
      return '';
    }
    if ((message.toolCalls?.length ?? 0) > 0) return '';
    if (message.content.trim()) return message.content;
  }
  return '';
}
