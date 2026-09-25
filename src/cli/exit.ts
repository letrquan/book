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

let exitCodeFn: (code: number) => void = (code: number): void => {
  process.exitCode = code;
};

/** Replace how a deferred exit code is recorded (for test injection). */
export function setExitCodeFn(fn: (code: number) => void): void {
  exitCodeFn = fn;
}

/**
 * Fail the process without ending it: record `code`, and let Node exit once its
 * last handle closes. Print mode ends a failed run this way. On Windows, `exit()`
 * straight after a pooled HTTP request aborts inside libuv
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), and the process
 * exits 127 instead of 1 (#243).
 */
export function setExitCode(code: number): void {
  exitCodeFn(code);
}
