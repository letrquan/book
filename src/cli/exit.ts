/**
 * Test-injectable process.exit() abstraction.
 *
 * All CLI modules should use `exit()` instead of `process.exit()` so that
 * tests can capture exit codes without actually terminating the process.
 */

let exitFn: (code: number) => never = (code: number): never => {
  process.exit(code);
};

let exiting = false;

/** Replace the exit implementation (for test injection). */
export function setExitFn(fn: (code: number) => never): void {
  exitFn = fn;
  exiting = false;
}

/** Exit the process with the given code. Tests can override via setExitFn. */
export function exit(code: number = 0): never {
  exiting = true;
  exitFn(code);
}

/** True when exit() has been called. Used by outer catch handlers to avoid double-exiting. */
export function isExiting(): boolean {
  return exiting;
}
