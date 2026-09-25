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
 * than an older turn's narration (#248). The supported shapes are pinned by
 * `final-answer.test.ts`.
 *
 * Known limit: a delegated task prompt and a slash-command body are
 * `derivedContent` too. When one opens a run that records nothing, the walk passes
 * over it, and an answer to an earlier prompt in the same history is returned, as
 * the pre-#248 rule did.
 */
export function finalAnswerText(history: readonly Message[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === 'user') {
      if (message.derivedContent) continue;
      return '';
    }
    if ((message.toolCalls?.length ?? 0) > 0) return '';
    if (message.content.trim()) return message.content;
  }
  return '';
}
