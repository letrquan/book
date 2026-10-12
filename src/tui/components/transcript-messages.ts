import type { Message } from '../../types/messages.js';
import { splitReasoningParts } from '../../reasoning-tags.js';
import { categoryFor } from '../../tools/catalog.js';

/**
 * Whether assistant content draws nothing.
 *
 * An empty reasoning block counts as blank. Routers that inline thinking emit
 * `<think></think>` ahead of every tool call, and treating that as content kept
 * each of those turns as a separate transcript entry with its own spacing: two
 * blank rows between every tool row of a run. A block with reasoning in it is
 * not blank, since it renders as a thought row.
 */
export function isBlankAssistantContent(content: string | undefined | null): boolean {
  if (!content || content.trim().length === 0) return true;
  return splitReasoningParts(content).every((part) => part.text.trim().length === 0);
}

/**
 * Whether a message delegates. AgentMessage hides a delegating message's
 * narration (the spawn has its own activity row), so a delegating turn must
 * never merge into one that carries narration, or that narration vanishes.
 */
export function delegatesWork(message: Message): boolean {
  return Boolean(message.toolCalls?.some((call) => call.name === 'AgentSpawn'));
}

/** Calls that hand the conversation back to you, or save a memory: not in a catalog category of their own. */
const HAND_BACK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'MemorySave']);

/**
 * Whether a call leaves the prose before it an answer: task bookkeeping (by
 * catalog category, so a new task tool is covered without editing this list)
 * and the calls that hand the conversation back to you.
 */
function isNonStepTool(name: string): boolean {
  return categoryFor(name) === 'tasks' || HAND_BACK_TOOLS.has(name);
}

/**
 * Whether an assistant entry is a step of work rather than an answer. The
 * bookkeeping and hand-back calls are classified by the tool catalog, which is
 * the same source the capability rules read. An answer that ends by updating
 * the plan is still the answer.
 */
export function isWorkStep(message: Message): boolean {
  if (message.role !== 'assistant' || message.kind === 'local' || message.localCommand)
    return false;
  return (message.toolCalls ?? []).some((call) => !isNonStepTool(call.name));
}

/**
 * Whether a message hands the conversation back to you (a question, a plan for
 * approval) or saves a memory. Its sentence stays in full ink even when work
 * follows it: the plan you approved and the question you answered are
 * landmarks, like your own turns.
 */
export function handsBack(message: Message): boolean {
  return (message.toolCalls ?? []).some((call) => HAND_BACK_TOOLS.has(call.name));
}

/**
 * The assistant messages that more work follows in the same turn.
 *
 * {@link isWorkStep} reads one message, so a message whose only call updated
 * the plan read as an answer even when the agent went on working: `I'll clone,
 * install, and launch that repo` sat in full ink between dimmed steps, the
 * brightest line of the turn and the least informative. An answer that ends by
 * updating the plan is still the answer, but only when no step comes after it.
 *
 * A turn ends at any user-role message. That includes the subagent and
 * background-shell notifications the transcript does not draw, which is why
 * this reads the messages rather than the timeline. The scan walks back from
 * the newest message and stops at `oldestId`, the first entry the transcript
 * draws, so a streamed delta costs the visible window, not the whole session.
 */
export function messagesFollowedByWork(
  messages: readonly Message[],
  oldestId?: string,
): ReadonlySet<string> {
  const followed = new Set<string>();
  let workFollows = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') {
      workFollows = false;
    } else {
      if (workFollows) followed.add(message.id);
      if (isWorkStep(message)) workFollows = true;
    }
    if (message.id === oldestId) break;
  }
  return followed;
}

/** Merge completed tool-only assistant messages into the preceding assistant turn for display. */
export function mergeAssistantMessages(
  messages: Message[],
  streamingMessageId?: string | null,
): Message[] {
  if (messages.length <= 1) return messages;

  const merged: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const current = messages[index];
    if (current.role !== 'assistant') {
      merged.push(current);
      index++;
      continue;
    }

    let mergedMessage: Message = { ...current };
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const next = messages[nextIndex];
      if (next.role !== 'assistant') break;
      if (!isBlankAssistantContent(next.content)) break;
      if (next.id === streamingMessageId) break;
      if (delegatesWork(next)) break;
      mergedMessage = {
        ...mergedMessage,
        reasoningContent:
          [mergedMessage.reasoningContent, next.reasoningContent]
            .filter((value): value is string => Boolean(value))
            .join('\n\n') || undefined,
        toolCalls: [...(mergedMessage.toolCalls ?? []), ...(next.toolCalls ?? [])],
        toolResults: [...(mergedMessage.toolResults ?? []), ...(next.toolResults ?? [])],
        nestedToolInvocations: [
          ...(mergedMessage.nestedToolInvocations ?? []),
          ...(next.nestedToolInvocations ?? []),
        ],
      };
      nextIndex++;
    }
    merged.push(mergedMessage);
    index = nextIndex;
  }

  return merged;
}

/**
 * Turns you wrote: the status line's folio counts one page for each. Subagent
 * and background-shell notifications arrive as user turns too
 * (`kind: 'agent-notification'`), and checkpoints and the carried ledger are
 * host text, so only conversation turns count.
 */
export function countWrittenTurns(messages: readonly Message[]): number {
  return messages.filter(
    (message) => message.role === 'user' && (message.kind ?? 'conversation') === 'conversation',
  ).length;
}
