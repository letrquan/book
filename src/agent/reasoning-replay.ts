import type { Message } from '../types/messages.js';

/**
 * The fewest newest assistant steps of the turn in progress that always go back
 * to the model with their reasoning attached.
 */
export const TURN_REASONING_REPLAY_WINDOW = 2;

/**
 * How many steps the replay cut moves at a time. A window that slid one step per
 * request rewrote a message the previous request had already sent with its
 * reasoning, which breaks the prompt-cache prefix on every single request: an
 * old message must not change often (CLAUDE.md, "sorted by volatility"). Stepping
 * the cut keeps between `TURN_REASONING_REPLAY_WINDOW` and
 * `TURN_REASONING_REPLAY_WINDOW + TURN_REASONING_REPLAY_STRIDE - 1` steps of
 * reasoning in flight and rewrites the prefix once every stride.
 */
export const TURN_REASONING_REPLAY_STRIDE = 4;

/**
 * The history index of the turn's first step whose reasoning goes back to the
 * model, or -1 when no step of the turn does.
 */
function firstReplayedStepIndex(history: readonly Message[]): number {
  // One backward pass: the turn's step count and the message that opened the
  // turn. A host-written user message (`derivedContent`: the `[continuation]`
  // resume, the completion gate, the `[work-state]` refresh) does not open a
  // turn, so a run keeps its chain of thought across them; a turn a later user
  // message closed is not replayed at all.
  let steps = 0;
  let turnStart = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (!candidate.includeInContext) continue;
    if (candidate.role === 'assistant') {
      steps += 1;
      continue;
    }
    if (candidate.role === 'user' && !candidate.derivedContent) {
      turnStart = index;
      break;
    }
  }
  if (steps === 0) return -1;

  const firstKept =
    steps <= TURN_REASONING_REPLAY_WINDOW
      ? 0
      : Math.floor((steps - TURN_REASONING_REPLAY_WINDOW) / TURN_REASONING_REPLAY_STRIDE) *
        TURN_REASONING_REPLAY_STRIDE;

  // The forward count from the turn's first message to the step the cut names.
  let seen = 0;
  for (let index = turnStart + 1; index < history.length; index += 1) {
    const candidate = history[index];
    if (!candidate.includeInContext || candidate.role !== 'assistant') continue;
    if (seen === firstKept) return index;
    seen += 1;
  }
  return -1;
}

/**
 * Which history indices keep their reasoning on the wire: the newest steps of
 * the turn in progress, the closed turns none, and everything when
 * `replayAllReasoning` is set. Every reader of a turn's reasoning (the request
 * builder, the token estimates) asks this one question, so what is counted and
 * what is sent can not drift apart.
 *
 * A step the predicate drops is sent as its answer and tool calls alone, the way
 * the Anthropic API drops earlier turns' thinking. `providerMetadata` is not
 * this question's business: the Anthropic path replays its signed thinking
 * blocks from there.
 */
export function reasoningReplayKeeps(
  history: readonly Message[],
  options?: { replayAllReasoning?: boolean },
): (index: number) => boolean {
  if (options?.replayAllReasoning) return () => true;
  const cut = firstReplayedStepIndex(history);
  if (cut < 0) return () => false;
  return (index: number) => index >= cut;
}
