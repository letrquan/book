import type { AgentTask } from '../types/runtime.js';
import type { ContinuationSettings } from '../settings.js';

/**
 * Deciding whether a turn that produced no tool calls should end the run.
 *
 * `runAgentLoop` breaks as soon as a turn has no tool calls, which makes one user
 * message the whole run: a model that writes "I've finished the auth module" and
 * stops exits as a normal completion even with half its plan outstanding. This
 * module decides when the host should instead append a user turn and keep going.
 *
 * It is deliberately pure — every stop condition is a data question, so the whole
 * safety envelope can be tested without a provider, a loop, or a clock.
 */

export interface ProgressWitness {
  /** Serialized todo list. */
  todos: string;
  /** Observed-file identity: path plus content hash, sorted. */
  files: string;
  /** Total tool calls made so far. */
  toolCalls: number;
  /** Exit code of the configured done-check, when one ran. */
  doneCheck?: number;
}

export interface ContinuationInput {
  settings: ContinuationSettings;
  todos: ReadonlyArray<{ content: string; status: string }>;
  tasks: readonly AgentTask[];
  /** Host-authored continuations already spent in this run. */
  consecutive: number;
  /** Witness signatures from previous continuation boundaries, oldest first. */
  priorWitnesses: readonly string[];
  witness: ProgressWitness;
  /** Milliseconds since the run began. */
  elapsedMs: number;
  /** Conditions under which continuing is never correct. */
  aborted?: boolean;
  handoffRequested?: boolean;
  planStopRequested?: boolean;
  budgetExhausted?: boolean;
  policyBlocked?: boolean;
}

export type ContinuationDecision =
  | { kind: 'stop'; reason: ContinuationStopReason }
  | { kind: 'continue'; prompt: string; trigger: 'todos' | 'tasks' };

export type ContinuationStopReason =
  | 'disabled'
  | 'objective_complete'
  | 'continuation_limit'
  | 'blocked_plan'
  | 'no_progress'
  | 'wall_clock'
  | 'external';

export function witnessSignature(witness: ProgressWitness): string {
  return JSON.stringify([witness.todos, witness.files, witness.toolCalls, witness.doneCheck]);
}

/**
 * Tasks that are neither finished nor waiting on something unfinished.
 *
 * A task blocked by an incomplete task is not actionable, so counting it would
 * keep a run alive that has nothing it can legally do next.
 */
function actionableTasks(tasks: readonly AgentTask[]): AgentTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter((task) => {
    if (task.status === 'completed' || task.status === 'deleted') return false;
    return !task.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return (
        blocker !== undefined && blocker.status !== 'completed' && blocker.status !== 'deleted'
      );
    });
  });
}

function continuationPrompt(remaining: string[], trigger: 'todos' | 'tasks'): string {
  const label = trigger === 'todos' ? 'task list' : 'plan';
  return [
    `[continuation] You stopped without completing the ${label}, and no one is watching this run.`,
    '',
    'Still outstanding:',
    ...remaining.map((item) => `- ${item}`),
    '',
    'Continue the work. If an item is genuinely done, mark it completed before stopping.',
    'If an item cannot be completed, say why and mark it so — do not leave it silently open.',
    'If everything really is finished, say so and stop.',
  ].join('\n');
}

/**
 * Decide what a turn with no tool calls means.
 *
 * The stop cases are checked before the continue cases, in order of authority:
 * an abort or a policy refusal outranks an unfinished plan.
 */
export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  if (!input.settings.enabled) return { kind: 'stop', reason: 'disabled' };

  // Anything that ended the turn for a reason of its own. Continuing past these
  // would override a decision that was not the model's to revisit — a cancel, an
  // approved plan handoff, a spent budget, a policy refusal.
  if (
    input.aborted ||
    input.handoffRequested ||
    input.planStopRequested ||
    input.budgetExhausted ||
    input.policyBlocked
  ) {
    return { kind: 'stop', reason: 'external' };
  }

  if (input.consecutive >= input.settings.maxConsecutive) {
    return { kind: 'stop', reason: 'continuation_limit' };
  }

  if (input.settings.maxWallClockMs > 0 && input.elapsedMs >= input.settings.maxWallClockMs) {
    return { kind: 'stop', reason: 'wall_clock' };
  }

  // The brake. A run that is spinning produces the same witness every time: same
  // todos, same file hashes, same tool-call count. Deliberately dumb — a real
  // progress signal is a subsystem, and this only has to catch "nothing at all is
  // changing" to stop a silent overnight spend.
  const signature = witnessSignature(input.witness);
  const identical = countTrailing(input.priorWitnesses, signature);
  if (identical >= input.settings.noProgressLimit) {
    return { kind: 'stop', reason: 'no_progress' };
  }

  const remainingTodos = input.todos.filter((todo) => todo.status !== 'completed');
  if (remainingTodos.length > 0) {
    return {
      kind: 'continue',
      trigger: 'todos',
      prompt: continuationPrompt(
        remainingTodos.map((todo) => todo.content),
        'todos',
      ),
    };
  }

  const openTasks = input.tasks.filter(
    (task) => task.status !== 'completed' && task.status !== 'deleted',
  );
  const remainingTasks = actionableTasks(input.tasks);
  if (remainingTasks.length === 0 && openTasks.length > 0) {
    // Open tasks exist but every one is waiting on unfinished work — a cycle, or a
    // blocker the model abandoned. Reporting `objective_complete` here would log
    // success for a stalled plan, so a deadlock gets its own reason.
    return { kind: 'stop', reason: 'blocked_plan' };
  }
  if (remainingTasks.length > 0) {
    return {
      kind: 'continue',
      trigger: 'tasks',
      prompt: continuationPrompt(
        remainingTasks.map((task) => task.subject),
        'tasks',
      ),
    };
  }

  return { kind: 'stop', reason: 'objective_complete' };
}

function countTrailing(values: readonly string[], target: string): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] !== target) break;
    count++;
  }
  return count;
}

/** Everything the no-progress brake watches, in one comparable value. */
export function buildProgressWitness(input: {
  todos: ReadonlyArray<{ content: string; status: string }>;
  fileObservations: ReadonlyMap<string, { sha256?: string }>;
  toolCallCount: number;
  doneCheck?: number;
}): ProgressWitness {
  return {
    todos: JSON.stringify(input.todos.map((todo) => [todo.content, todo.status])),
    files: JSON.stringify(
      [...input.fileObservations.entries()]
        .map(([key, observation]) => `${key}:${observation.sha256 ?? ''}`)
        .sort(),
    ),
    toolCalls: input.toolCallCount,
    doneCheck: input.doneCheck,
  };
}

/**
 * A host-authored restatement of the plan, appended every N turns.
 *
 * Two problems, one mechanism. It keeps the plan from going stale across a long
 * tool-grinding stretch, and — because `splitUserLedBundles` opens a compaction
 * bundle on any non-checkpoint user message — it is the *guaranteed* source of
 * bundle boundaries. A run that grinds tool calls for hundreds of turns never
 * stops, so it never produces a continuation message either; without this the
 * candidate span is all-assistant, `bundles` comes back empty, and compaction
 * retains a zero-message tail at generation 2 and beyond.
 *
 * Returns undefined when there is no plan worth restating.
 */
export function renderWorkState(input: {
  todos: ReadonlyArray<{ content: string; status: string }>;
  tasks: readonly AgentTask[];
}): string | undefined {
  const todos = input.todos.filter((todo) => todo.status !== 'completed');
  const tasks = input.tasks.filter(
    (task) => task.status !== 'completed' && task.status !== 'deleted',
  );
  if (todos.length === 0 && tasks.length === 0) return undefined;

  const lines = ['[work-state] Current plan, restated by the host. This is not a new instruction.'];
  if (todos.length > 0) {
    lines.push('', 'Open items:');
    for (const todo of todos) lines.push(`- [${todo.status}] ${todo.content}`);
  }
  if (tasks.length > 0) {
    lines.push('', 'Open tasks:');
    for (const task of tasks) {
      const blockers = task.blockedBy.length ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
      lines.push(`- [${task.status}] ${task.subject}${blockers}`);
    }
  }
  return lines.join('\n');
}

export { actionableTasks };
