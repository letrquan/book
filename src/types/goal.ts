/**
 * A session goal set with `/goal <condition>`: the host keeps the agent working
 * until a separate evaluator judges, from the transcript, that the condition
 * holds. Lives on the session runtime and survives a resume through `goal`
 * session records.
 */
export interface ActiveGoal {
  /** The condition as the user wrote it; also the agent's directive. */
  condition: string;
  /** Evaluations that found the condition unmet. */
  iterations: number;
  /** Epoch milliseconds when the goal was set. */
  setAt: number;
  /** `restored` when a resume brought back a goal set in an earlier process. */
  origin: 'user' | 'restored';
  /** Output tokens the root agent and the goal checks have spent while the goal was set. */
  outputTokens: number;
  /** The evaluator's reason from the most recent unmet check. */
  lastReason?: string;
}

/** What the evaluator concluded at one stop. */
export type GoalVerdict =
  | { kind: 'met'; reason: string }
  | { kind: 'unmet'; reason: string }
  | { kind: 'impossible'; reason: string }
  /** The check could not run or its answer was unreadable. Fails open: the turn ends, the goal stays. */
  | { kind: 'error'; detail: string };

/** One change in a goal's state, reported to the host as it happens. */
export type GoalStatusEvent =
  | { state: 'set'; condition: string }
  | { state: 'cleared'; condition: string }
  | { state: 'unmet'; condition: string; reason: string; iterations: number }
  | {
      state: 'met' | 'failed';
      condition: string;
      reason: string;
      iterations: number;
      durationMs: number;
      tokens: number;
    }
  | {
      state: 'paused';
      condition: string;
      cause: 'block_cap' | 'check_failed';
      detail?: string;
    };
