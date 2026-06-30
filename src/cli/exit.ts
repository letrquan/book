/**
 * Test-injectable process.exit() abstraction.
 *
 * All CLI modules should use `exit()` instead of `process.exit()` so that
 * tests can capture exit codes without actually terminating the process.
 */

let exitFn: (code: number) => never = (code: number): never => {
  process.exit(code);
};

/** Replace the exit implementation (for test injection). */
export function setExitFn(fn: (code: number) => never): void {
  exitFn = fn;
}

/** Exit the process with the given code. Tests can override via setExitFn. */
export function exit(code: number = 0): never {
  exitFn(code);
}
