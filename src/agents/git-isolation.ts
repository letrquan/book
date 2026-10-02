import { createHash, randomUUID } from 'crypto';
import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { AgentApplyResult, AgentRecord, AgentSnapshot, PatchCandidate } from './types.js';
import { buildChildEnv } from '../child-env.js';
import { resolveBookHome } from '../book-home.js';
import { hardenedGitArgs, hardenedGitEnv, HARDENED_DIFF_ARGS } from '../tools/git.js';
import {
  signingPinArgs,
  type HardenedRunner,
  type RunOptions,
  type RunResult,
} from './git-signing.js';

/**
 * Every git command this module runs: a synthetic snapshot, an agent's worktree, the agent's
 * commit, and the cherry-pick or patch that applies the result.
 *
 * The argv goes through {@link hardenedGitArgs} and the environment carries a pager and a
 * credential prompt it cannot wait on, here as in the read-only Git tools. What is different is
 * the one that matters for this module: several of these are writes — `commit`, `cherry-pick`,
 * `worktree add`, `update-ref` — and a checkout could own a hook, an `fsmonitor`, or a diff driver
 * for any of them. None of this is the operator's work, and none of it is a call anything asks
 * before, so a repository can run a program by delegating an agent (#348). Turning hooks off for
 * it is the decision here; the operator's own commits, `GitCommit` included, keep theirs.
 *
 * It is applied inside {@link run} rather than at each call site, so a new call site cannot forget
 * it, and `git-signing.ts` is given that function rather than a runner of its own for the same
 * reason: a fix here reaches every read that decides how a commit is signed.
 *
 * **What is still followed, deliberately (#357).** Hooks, `core.fsmonitor` and the diff drivers
 * are off, and the agent's own commit is unsigned, but three routes a checkout owns remain open,
 * because closing them would change the content Book manages:
 *
 * - **`.gitattributes` clean/smudge and process filters.** They rewrite the bytes on checkout and
 *   on add, and a process filter is a program the checkout names. `git-lfs` needs them: without
 *   them a pointer file is a pointer file rather than the large blob it stands for.
 * - **`.gitattributes` merge drivers.** The cherry-pick that applies an agent's result merges
 *   through whatever the checkout names, for the same reason.
 * - **Lazy fetch in a partial clone.** `--filter=blob:none` means a missing blob is fetched on
 *   demand, through the `credential.helper` and `core.sshCommand` that fetch needs.
 *
 * So a checkout can still have Book run a program through one of those three, and that is a known
 * gap rather than an oversight: it is tracked as issue 357, and the decision belongs to whoever
 * clones a repository that carries a `.gitattributes` naming a program.
 *
 * Three properties of a child are load-bearing for the reads this module makes, and all three
 * live here rather than at the call sites because each one has a way of failing *open*:
 *
 * - **A non-numeric error never resolves.** `allowExitCodes` names real exit codes, so only a real
 *   exit code can satisfy it. A `maxBuffer` overrun, a missing `git`, a signal or a timeout all
 *   arrive with a string code, a null code, or no code at all, and each of them used to be read as
 *   exit 1 — which `git config --get-regexp` uses for "no match". A signing read that resolved on a
 *   truncated answer would pin nothing and let a repository's configuration through untouched. A
 *   child killed by an abort or by the timeout below has no exit code at all, which is a failure
 *   and not a 1: `removeAgentWorktree` accepts 1 and 128 as "already gone", and reading a kill as
 *   either would report a cleanup that never happened as one that did.
 * - **stdin is closed, not an open pipe.** A signer that reads stdin — an ssh key with a
 *   passphrase and no agent, a loopback pinentry — otherwise waits on a pipe nobody will ever
 *   write to, for as long as the session lasts. Only the calls that write a patch get one.
 * - **A call that can start a program is bounded, and can be stopped.** A signing program that
 *   never returns is the same hang from the other side, so every call carries
 *   {@link DEFAULT_GIT_TIMEOUT_MS} unless it names its own, and the agent controller's signal is
 *   threaded through the calls that have one so a stopped agent stops its git too (#357).
 *
 * And the environment is not the operator's shell environment: an ambient `GIT_DIR` or
 * `GIT_INDEX_FILE` would redirect Book's own writes into another checkout, which is a write
 * nobody asked about in a repository nobody named. See {@link internalGitEnv}.
 */
function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  const env = internalGitEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const signal = options.signal;
  // An already-aborted signal must not start the child at all: the work it was asked to do is over,
  // and a child started now would outlive the abort that was supposed to stop it — a `worktree
  // add` that keeps going after its agent was stopped writes a checkout and a branch nothing asked
  // for (#357).
  if (signal?.aborted) {
    return Promise.reject(new Error(stoppedDescription(command, args, 'aborted', null, timeoutMs)));
  }
  if (options.input !== undefined) {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      // `close` and a stdin write can both report the same failed command, and a spawn that
      // never happened reports twice. One outcome, whichever arrives first (#351).
      let settled = false;
      let cancelEscalation: (() => void) | undefined;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancelEscalation?.();
        outcome();
      };
      // How this child was stopped, when it was: the reason is what the message says, and a
      // `close` handler that only sees `signal: SIGTERM` cannot tell a timeout from an abort.
      let stoppedBy: 'timeout' | 'aborted' | undefined;
      const stopChild = (reason: 'timeout' | 'aborted') => {
        if (stoppedBy === undefined) stoppedBy = reason;
        cancelEscalation = stopEscalating(child, () =>
          settle(() =>
            reject(
              new Error(stoppedDescription(command, args, stoppedBy, child.signalCode, timeoutMs)),
            ),
          ),
        );
      };
      const onAbort = () => stopChild('aborted');
      const timer = timeoutMs > 0 ? setTimeout(() => stopChild('timeout'), timeoutMs) : undefined;
      timer?.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      // A stdin failure worth acting on is remembered rather than acted on, because `close` is
      // the only event that knows the exit code, and the exit code is what decides. Settling here
      // instead would reject before git had written the stderr that explains the failure.
      let stdinError: Error | undefined;
      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      // A read stream can fail on its own — a pipe closed as the child goes, a host under
      // pressure — and a stream with no `error` listener raises that on the host's event loop,
      // which takes down whatever session was mid-flow. Remembered and weighed by `close` for the
      // same reason the stdin error is: the exit code is the thing that decides.
      let outputError: Error | undefined;
      child.stdout.on('error', (error: Error) => (outputError ??= error));
      child.stderr.on('error', (error: Error) => (outputError ??= error));
      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle(() => reject(error));
      });
      child.on('close', (codeValue, closedBySignal) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle(() => {
          // A child with no exit code has none to reason about, so it is a failure whatever
          // `allowExitCodes` names — including the timeout this call set for it and the abort
          // that stopped it. `codeValue ?? 1` made every kill indistinguishable from the exit 1
          // git uses for "no such branch" (#357).
          const code = typeof codeValue === 'number' ? codeValue : undefined;
          if (code === undefined) {
            reject(
              new Error(
                stderr.trim() ||
                  stdout.trim() ||
                  outputError?.message ||
                  stdinError?.message ||
                  stoppedDescription(command, args, stoppedBy, closedBySignal, timeoutMs),
              ),
            );
            return;
          }
          if (code === 0 || options.allowExitCodes?.includes(code)) {
            resolvePromise({ stdout, stderr, code });
            return;
          }
          // What git said comes first: a stdin error on a failed command is a consequence of it,
          // and its own message is the one with no information in it. The stdin error is the
          // fallback for a git that exited without a word.
          reject(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                stdinError?.message ||
                `${command} ${subcommandOf(args)} failed (${code})`,
            ),
          );
        });
      });
      // Never removed, and attached before the write: git that exits without reading the patch —
      // not a repository, a rejected argument — leaves that write to fail with EPIPE, and a
      // stream carrying no `error` listener raises the failure on the host's event loop instead
      // of on this promise. `EPIPE` and `EOF` mean git was gone before it read, which the exit
      // code has already accounted for and is not news; anything else is a real failure, and is
      // kept for `close` to weigh.
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE' || error.code === 'EOF') return;
        stdinError ??= error;
      });
      child.stdin.end(options.input);
    });
  }

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let cancelEscalation: (() => void) | undefined;
    // Both closures below read `timer`, which is assigned after `child`: `execFile`'s callback is
    // always asynchronous, so nothing settles before there is a timer to clear.
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cancelEscalation?.();
      outcome();
    };
    let stoppedBy: 'timeout' | 'aborted' | undefined;
    // The abort is handled here rather than by `execFile`'s own `signal` option, because that one
    // sends SIGTERM, calls straight back, and is finished with the child: a git that traps or
    // ignores SIGTERM, or a grandchild of its own holding the output pipe, outlives the rejection
    // that was supposed to stop it (#357). Both paths stop a child the same way — see
    // {@link stopEscalating}.
    const stopCall = (reason: 'timeout' | 'aborted') => {
      if (stoppedBy === undefined) stoppedBy = reason;
      cancelEscalation = stopEscalating(child, () =>
        settle(() =>
          reject(
            new Error(
              failureDescription(
                { killed: true },
                '',
                command,
                args,
                timeoutMs,
                reason === 'aborted',
              ),
            ),
          ),
        ),
      );
    };
    const onAbort = () => stopCall('aborted');
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env,
        encoding: 'utf8',
        // One buffer for every call: a signing read that overruns it has to fail rather than
        // resolve on a prefix, and this size is what makes that impractical rather than what makes
        // it correct.
        maxBuffer: 50 * 1024 * 1024,
        // No `timeout` and no `signal` option here. `execFile`'s own timeout kills the child but
        // still waits for its output to close, and a grandchild holding that pipe — a shell script,
        // a `credential.helper` that started something of its own — means it never does, so the
        // callback that would report the timeout may never arrive; its `signal` sends SIGTERM and
        // then stops looking. The timer below bounds the call and `stopEscalating` ends the child.
      },
      (error, stdout, stderr) => {
        // Node reports a failure three ways and only one of them is an exit code: `killed` and
        // `signal` cover a timeout and a signal, and a `maxBuffer` overrun or a missing binary
        // arrives as a string in `code`. None of those may resolve as if it were the "no match"
        // that exit 1 means, so an exit code is used only where there is one.
        const code = exitCodeOf(error);
        if (code === undefined) {
          settle(() =>
            reject(
              new Error(
                failureDescription(
                  error,
                  stderr || stdout,
                  command,
                  args,
                  timeoutMs,
                  stoppedBy === 'aborted',
                ),
              ),
            ),
          );
          return;
        }
        if (code === 0 || options.allowExitCodes?.includes(code)) {
          settle(() => resolvePromise({ stdout, stderr, code }));
          return;
        }
        settle(() =>
          reject(
            new Error(
              // git's own words first, because they are the ones that say what went wrong. Then the
              // composed message, and not Node's: with no output to prefer, Node's is the whole argv
              // — hardening pairs included — which names `-c` where a reader needs the subcommand,
              // and says nothing that the exit code does not (#357).
              stderr.trim() || stdout.trim() || `${command} ${subcommandOf(args)} failed (${code})`,
            ),
          ),
        );
      },
    );
    const timer = timeoutMs > 0 ? setTimeout(() => stopCall('timeout'), timeoutMs) : undefined;
    timer?.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    // `execFile` leaves the child's stdin an open pipe that nothing will ever write to, and a
    // child that reads it waits for an end that never comes: an ssh signer asking for a passphrase,
    // a pinentry on a loopback socket. Closing it now is what makes such a read fail, which is
    // what a command Book did not choose to read input from should do. (Checked against a real
    // git: a program that reads stdin to the end otherwise holds its call open indefinitely.)
    child.stdin?.end();
  });
}

/**
 * How long any call in this module may take before it is killed.
 *
 * Generous on purpose: the longest call here is the cherry-pick that applies an agent's result, on
 * a large repository, and killing it costs the operator a re-apply. What this buys is that a git
 * which never exits — a signing program waiting on an agent that is not there, a filesystem that
 * has stopped answering, a `credential.helper` prompt Book cannot see — cannot hold a call, and
 * through it a session, open forever (#357). The cherry-pick still names its own, longer budget.
 */
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/**
 * How long a signalled child has to be on its way out before it is killed outright.
 *
 * Two seconds is far longer than git needs to unwind — to delete the `index.lock` it took, to
 * roll a half-written ref back, to leave a worktree's administrative directory consistent — and
 * far shorter than a caller that has already been bounded by {@link DEFAULT_GIT_TIMEOUT_MS} should
 * then sit waiting. This is only the shape of the escalation, not the budget of the call.
 */
const KILL_GRACE_MS = 2_000;

/** The part of a child process this module has to be able to stop and then ask about. */
interface StoppableChild {
  kill(signal: NodeJS.Signals): boolean;
  /** The exit code, or `null` while the child is running. */
  exitCode: number | null;
  /** The signal that killed it, or `null` while it has not been killed. */
  signalCode: NodeJS.Signals | null;
}

/**
 * Stop a child that has to end now — SIGTERM first, then SIGKILL only if it is still alive when
 * the grace is up — and hand back how to call that off.
 *
 * **SIGTERM first is the whole point, and skipping it was a bug of its own.** A mutating git takes
 * `.git/index.lock` for as long as it runs — `cherry-pick`, `worktree add`, `add -A`,
 * `update-ref` all do — and releases it on the way out, which is the only thing that releases it.
 * `SIGKILL` gives the process no way out, so a call bounded by being killed outright left a lock
 * behind on the operator's repository, and the next call in it — the cleanup, the operator's next
 * commit — failed on a lock no process is holding (#357). It is also what a program gets the
 * chance to be a program rather than be reaped: a signing helper or a filter that releases
 * something on its way out gets to.
 *
 * The escalation is what makes the stop a fact rather than a request. SIGTERM alone leaves a child
 * that traps it, or that has a grandchild holding the pipes open, running while the promise this
 * call is awaited by has already rejected — which is the hang the timeout exists to prevent, one
 * level down. So when the grace is up, anything still alive is killed, and `settled` runs whether
 * or not the child was ever going to close: a `close` that may never arrive cannot be the only way
 * this promise settles.
 *
 * The returned function cancels a grace that has not come due, for the callers that settle first —
 * a child that honoured SIGTERM settles from its own `close`, and nothing should kill anything
 * after that.
 */
function stopEscalating(child: StoppableChild, settled: () => void): () => void {
  child.kill('SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) {
    // Already gone — a timeout that fired in the same tick as the exit — and there is nothing left
    // to escalate to. The caller settles from the exit it already has.
    return () => {};
  }
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    settled();
  }, KILL_GRACE_MS);
  escalation.unref?.();
  return () => clearTimeout(escalation);
}

/**
 * The subcommand an argv actually runs, for a message that has to name it.
 *
 * Every argv here arrives with the hardening's `-c key=value` pairs in front of it, and a message
 * built from `args[0]` therefore names `-c`: the manifest read reported `git -c failed`, which
 * names a flag and tells a reader nothing about which command died (#357).
 */
function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    // `-c key=value` and `-C <path>` each take the next argument as their value, so the value is
    // not mistaken for the subcommand. `--key=value` carries its own.
    if (arg === '-c' || arg === '-C') {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '(no subcommand)';
}

/** What a child that produced no exit code is reported as, naming the command that produced it. */
function stoppedDescription(
  command: string,
  args: readonly string[],
  stoppedBy: 'timeout' | 'aborted' | undefined,
  closedBySignal: NodeJS.Signals | null,
  timeoutMs: number,
): string {
  const invocation = `${command} ${subcommandOf(args)}`;
  if (stoppedBy === 'timeout') {
    return `${invocation} timed out after ${timeoutMs}ms and was killed`;
  }
  if (stoppedBy === 'aborted') return `${invocation} was cancelled`;
  if (closedBySignal) return `${invocation} was killed with ${closedBySignal}`;
  return `${invocation} was killed and produced no result`;
}

/**
 * How a child process can fail without ever producing an exit code.
 *
 * Every field is optional because each shape arrives from somewhere different: Node's own failure
 * object, a spawn that never happened, and the placeholder this module builds when its own timer
 * fires and settles the promise before Node reports anything.
 */
interface ProcessFailure {
  name?: string;
  message?: string;
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
}

/** A child's exit code, or `undefined` for anything that is not one — which is a failure, not a 1. */
function exitCodeOf(error: ProcessFailure | null): number | undefined {
  // No error at all is the success case, and it is the one shape of "no exit code" that is not a
  // failure: `execFile` reports it by passing `null`, not by passing a code.
  if (!error) return 0;
  if (error.killed || error.signal) return undefined;
  // An abort arrives as an `AbortError` with no code at all, which is not an exit code either.
  if (isAbortError(error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}

/** Whether a failure is the one Node raises for an aborted call, which carries no exit code. */
function isAbortError(error: ProcessFailure | null): boolean {
  return error?.name === 'AbortError' || (error as { code?: unknown } | null)?.code === 'ABORT_ERR';
}

function failureDescription(
  error: ProcessFailure | null,
  output: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  aborted: boolean,
): string {
  const invocation = `${command} ${subcommandOf(args)}`;
  if (aborted || isAbortError(error)) return `${invocation} was cancelled`;
  if (error?.killed) return `${invocation} timed out after ${timeoutMs}ms and was killed`;
  if (error?.signal) return `${invocation} was killed with ${error.signal}`;
  if (typeof error?.code === 'string') return `${invocation} failed: ${error.code}`;
  return output.trim() || error?.message || `${invocation} failed`;
}

/**
 * The variables that say **which repository** git operates on, and the only ones this module
 * removes from the environment.
 *
 * Each of them outranks the directory a call is started in: a shell that exported `GIT_DIR` to work
 * inside a bare repository, a CI step, a hook, or a CI job that shares a runner is enough. Every
 * call in this module is *Book's* write to a repository the caller named — a snapshot object, a
 * worktree, a branch, a commit on the operator's branch — so an ambient one of those would send
 * those writes somewhere nobody asked about, and a stray `GIT_INDEX_FILE` would stage an agent's
 * work into the wrong index (#357).
 *
 * The list is deliberately this list and not "everything beginning `GIT_`". Deleting the rest took
 * away the operator's configuration for operations Book performs on their behalf: `GIT_SSH_COMMAND`
 * and `core.sshCommand`'s environment, `GIT_SSL_CAINFO` and `GIT_SSL_NO_VERIFY`, `GIT_ASKPASS`,
 * `GIT_EXEC_PATH`, `GIT_PROXY_COMMAND` — the settings a corporate network, an offline clone, or a
 * self-signed remote needs, none of which chooses a repository and all of which silently change a
 * call from working to failing when they are removed. `GIT_CEILING_DIRECTORIES` is kept for the same
 * reason and one more: it makes git's upward search *stop earlier*, which narrows where Book can be
 * pointed rather than redirecting it.
 */
const GIT_REPOSITORY_SELECTION_VARIABLES: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // The index *format* rather than the index's location, and kept in this list for the same
  // reason as the index itself: a snapshot stages into a temporary index of its own, and an
  // ambient version would have git write that index in a format the operator's own git may refuse
  // to read back.
  'GIT_INDEX_VERSION',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]);

/**
 * The environment Book's own git runs with, which is not the operator's shell environment.
 *
 * {@link GIT_REPOSITORY_SELECTION_VARIABLES} is what comes out; everything else the operator set is
 * theirs and is left alone, including the two kinds that are most obviously not repository
 * pointers:
 *
 * - **`GIT_AUTHOR_*` and `GIT_COMMITTER_*`**, which are identity rather than location. They are
 *   how a caller names the author of a commit Book is about to make on its behalf, and
 *   {@link gitIdentityEnv} sets the same four for Book's own commits.
 * - **`GIT_CONFIG_*`**, which choose *which configuration* git reads rather than *what it
 *   operates on*. This module reads configuration on purpose — that is what decides how the
 *   cherry-pick signs — so an operator who points `GIT_CONFIG_GLOBAL` at their own file, or a
 *   hermetic test that points it at an empty one, is being obeyed rather than overridden.
 *
 * What is added is the hardening's own environment, spread **last** so that a pager and a
 * credential prompt cannot be turned back on by a call site or by an ambient variable: no call here
 * reads from a terminal Book is watching, so `GIT_TERMINAL_PROMPT=0` is what keeps a git that wants
 * a passphrase from waiting for one that will never be typed (#357).
 */
function internalGitEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const ambient = buildChildEnv(process.env);
  for (const name of GIT_REPOSITORY_SELECTION_VARIABLES) delete ambient[name];
  // The call site's own environment is spread next, so a `GIT_INDEX_FILE` naming a temporary index
  // — the snapshot's, the pre-check's — is Book's own decision and outranks the ambient one it has
  // just removed.
  return { ...ambient, ...overrides, ...hardenedGitEnv() };
}

/** git, with the argv hardening that belongs to git and not to {@link run}. */
function git(
  cwd: string,
  args: string[],
  options: Omit<RunOptions, 'cwd'> = {},
): Promise<RunResult> {
  return run('git', hardenedGitArgs(args), { ...options, cwd });
}

/**
 * {@link git}, exported for tests only, and reached through `git-isolation-internal.ts` rather than
 * from here: see that module for why.
 *
 * No exported path reaches `git()`'s `input` branch without a real snapshot, and #351 needs a patch
 * git exits on before reading it.
 */
export const gitForTest = git;

/** The runner `git-signing.ts` reads the signing configuration through; see {@link HardenedRunner}. */
const hardenedRunner: HardenedRunner = run;

/**
 * What Book reports about a cherry-pick that failed, given what the pick left behind and what the
 * rollback itself did.
 *
 * Two questions have separate answers and used to share one sentence. **Was it rolled back?** only
 * the `cherry-pick --abort` that ran afterwards can say, and that call can fail — a repository
 * that is no longer one, a lock it cannot take — so a swallowed abort turned a pick that is still
 * in progress into "rolled back", and an operator reading that would commit their next change into
 * the agent's pick (#357). **Was it a conflict?** only the working tree can say: unmerged paths and
 * markers are a conflict, while a signing failure, a filter that would not run, or a repository
 * that is read-only is the machinery failing, and calling those conflicts sends the reader looking
 * for markers that are not there.
 *
 * The two answers cross on **status**, and which way they cross is the point of this signature.
 * `not_applied` means "nothing was written, and running it again is a reasonable thing to try" — a
 * rolled-back pick with no unmerged paths is exactly that. `conflicted` is the status every other
 * "an operator has to look at this before anything else happens" outcome in this module already
 * uses, and a repository left mid-cherry-pick is that outcome even when nothing conflicted: the
 * next `cherry-pick` in it fails outright, and `applyVerifiedCandidate` refuses to start one while
 * `CHERRY_PICK_HEAD` exists, so a status that reads as "just try again" sends a retry into a
 * repository that is waiting for a `--continue` or an `--abort` it was never told about. It is the
 * closest status the vocabulary has, and it is the closest to the truth.
 *
 * Reached through `git-isolation-internal.ts`, which is where the test-only exports live; see that
 * module for why this one is among them.
 */
export function cherryPickFailureResult(facts: {
  /** What the cherry-pick said when it failed. */
  pickError: string;
  /** What `cherry-pick --abort` said, when it failed rather than rolling the pick back. */
  abortError?: string;
  /** The paths the pick left unmerged, read before the abort removed them. */
  unmergedPaths: readonly string[];
}): AgentApplyResult {
  const conflicted = facts.unmergedPaths.length > 0;
  if (facts.abortError) {
    return {
      // Not `conflicted ? 'conflicted' : 'not_applied'`, which is what the conflict claim alone
      // decides: a pick whose rollback did not run is not retryable whether or not it conflicted,
      // and reporting the narrower of the two claims is what made an operator commit into a
      // repository that was still mid-pick.
      status: 'conflicted',
      error: `Cherry-pick failed (${facts.pickError}) and the rollback did not complete (${facts.abortError}), so this repository may be left mid-cherry-pick: finish it with git cherry-pick --continue or undo it with git cherry-pick --abort.`,
    };
  }
  return {
    status: conflicted ? 'conflicted' : 'not_applied',
    error: `Cherry-pick failed and was rolled back: ${facts.pickError}`,
  };
}

function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: 'Book Agent',
    GIT_AUTHOR_EMAIL: 'agents@book.local',
    GIT_COMMITTER_NAME: 'Book Agent',
    GIT_COMMITTER_EMAIL: 'agents@book.local',
  };
}

function tempIndex(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'book-index-'));
  return { dir, path: join(dir, 'index') };
}

export async function findGitRoot(
  workspace: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await git(workspace, ['rev-parse', '--show-toplevel'], { signal })).stdout.trim();
  } catch {
    return undefined;
  }
}

export function repositoryHash(repoRoot: string): string {
  return createHash('sha256').update(resolve(repoRoot).toLowerCase()).digest('hex').slice(0, 20);
}

async function writeWorkspaceTree(
  repoRoot: string,
  includeUntracked: boolean,
  signal?: AbortSignal,
): Promise<{ head: string; tree: string; status: string }> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    const head = (await git(repoRoot, ['rev-parse', 'HEAD'], { signal })).stdout.trim();
    await git(repoRoot, ['read-tree', head], { env, signal });
    await git(repoRoot, includeUntracked ? ['add', '-A', '--', '.'] : ['add', '-u', '--', '.'], {
      env,
      signal,
    });
    const tree = (await git(repoRoot, ['write-tree'], { env, signal })).stdout.trim();
    const status = (
      await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'], { signal })
    ).stdout;
    return { head, tree, status };
  } finally {
    rmSync(index.dir, { recursive: true, force: true });
  }
}

export async function currentWorkspaceFingerprint(
  repoRoot: string,
  includeUntracked: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const { head, tree } = await writeWorkspaceTree(repoRoot, includeUntracked, signal);
  return `${head}:${tree}`;
}

/**
 * The caller's own signal, threaded through every git this snapshot makes.
 *
 * A stopped agent still has this snapshot to finish, and `git status` over a large checkout is
 * exactly the call that takes minutes: without the signal the stop is a request that the snapshot
 * only hears when it is over. The per-call {@link DEFAULT_GIT_TIMEOUT_MS} remains the floor, for a
 * caller with no signal to pass.
 */
export async function createSyntheticSnapshot(
  workspace: string,
  includeUntracked = true,
  signal?: AbortSignal,
): Promise<AgentSnapshot> {
  const repoRoot = await findGitRoot(workspace, signal);
  if (!repoRoot) {
    throw new Error(
      'Managed agents require a Git workspace with at least one commit. Use --agents off for this workspace.',
    );
  }
  const id = randomUUID();
  const { head, tree, status } = await writeWorkspaceTree(repoRoot, includeUntracked, signal);
  const commit = (
    await git(repoRoot, ['commit-tree', tree, '-p', head, '-m', `book synthetic snapshot ${id}`], {
      env: gitIdentityEnv(),
      signal,
    })
  ).stdout.trim();
  const repoHash = repositoryHash(repoRoot);
  const ref = `refs/book/snapshots/${repoHash}/${id}`;
  await git(repoRoot, ['update-ref', ref, commit], { signal });

  const manifestOutput = (
    await git(
      repoRoot,
      [
        '-c',
        'core.quotepath=false',
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-M',
        head,
        commit,
      ],
      { signal },
    )
  ).stdout;
  const manifest = manifestOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [statusCode, ...paths] = line.split('\t');
      return { status: statusCode, path: paths.join(' -> ') };
    });

  return {
    id,
    repoRoot,
    repoHash,
    baseHead: head,
    commit,
    tree,
    ref,
    fingerprint: `${head}:${tree}`,
    dirty: status.trim().length > 0,
    includeUntracked,
    manifest,
    createdAt: Date.now(),
  };
}

/** Where agent worktrees live when a host does not override the root. */
export function defaultWorktreeRoot(): string {
  return join(resolveBookHome(), 'worktrees');
}

/** Whether a branch is already in the repository, which decides who may delete it afterwards. */
async function branchExists(
  repoRoot: string,
  branch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    allowExitCodes: [1],
    signal,
  });
  return result.code === 0;
}

/**
 * Delete a branch Book created, best effort, and only one Book created.
 *
 * `worktree add -b` creates the branch before it checks out, so a checkout that is refused after
 * that point — a path that is already a file, a directory that is not empty, a start commit that
 * does not resolve — leaves the branch behind and every retry fails with `already exists`, which
 * reads like the agent's work is still there rather than like a branch Book leaked (#357). The
 * caller checks whether the branch was there first: a branch that already existed is the
 * operator's, with their commits on it, and `branch -D` on it would destroy work Book never made.
 *
 * Bound by its own timeout rather than by the caller's signal, because every caller of this is a
 * cleanup running *because* the add it belongs to failed or was aborted — see
 * {@link removeWorktree}.
 */
async function deleteBranchBookCreated(
  repoRoot: string,
  branch: string,
  existed: boolean,
): Promise<void> {
  if (existed) return;
  await git(repoRoot, ['branch', '-D', branch], { allowExitCodes: [1, 128] }).catch(() => {});
}

/**
 * Whether the worktree at `path` is one an agent can work in, rather than a directory an
 * interrupted `worktree add` left behind.
 *
 * The pointer file is not the test, and treating it as one is what this replaces (#357).
 * `worktree add` writes `<path>/.git` before it checks anything out — before it has a branch worth
 * the name and before there is a working tree — so a run whose add was killed by this module's own
 * timeout, by the agent's stop, or by a signal that took the process with it, leaves exactly that
 * file behind. The old `existsSync(join(path, '.git'))` read it as "a worktree Book already made",
 * adopted it, and handed the agent a checkout with no files in it: a run that appears to work and
 * produces an empty patch, against a branch nobody can use.
 *
 * Two reads, because one is not enough. `rev-parse --verify HEAD` goes through the pointer, the
 * administrative directory and the object store at once, so it fails for every half-state that
 * pointer cannot reach — an administrative directory `worktree prune` already removed, a pointer
 * into another repository, a branch whose commit is gone. HEAD resolving on its own says less than
 * it looks: it resolves from the administrative directory alone, with no index and no checkout, so
 * the index is checked too. A checkout writes it as it goes, and a git killed partway through
 * leaves the administrative directory without one.
 */
async function worktreeIsComplete(path: string, signal?: AbortSignal): Promise<boolean> {
  if (!existsSync(join(path, '.git'))) return false;
  try {
    const administrative = (
      await git(path, ['rev-parse', '--absolute-git-dir'], { signal })
    ).stdout.trim();
    if (!existsSync(join(administrative, 'index'))) return false;
    await git(path, ['rev-parse', '--verify', 'HEAD'], { signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the worktree at `path`, the record git keeps for it, and the directory itself.
 *
 * Two calls and then a directory, because each one is what lets the next one work. `worktree
 * remove --force` deletes the checkout and its administrative directory together, and it is the
 * only one of the three that refuses while a git still holds an index lock from the killed call
 * — which is why it runs first and why the others are allowed to fail. `worktree prune` then
 * clears an entry git could not remove.
 *
 * The directory is last because git is what normally removes it, and it is here because git
 * refuses a path it does not recognise as one of its worktrees — which is exactly what a killed
 * add has left. The `.git` at that path is the guard, and it is the whole claim: what goes is a
 * directory that presents itself as a git repository under Book's own agent path, which is
 * only thing this function is ever called on. A directory without one is not a worktree, and is
 * left for git's own refusal to report rather than removed on a guess.
 *
 * Deliberately **not** given the caller's signal. This runs because an add failed *or was aborted*,
 * and a cleanup bound to the very signal that stopped it would not run at all — which is the state
 * the retry then has to clean up instead. Each call is bounded by its own timeout, so the cleanup
 * cannot hang on the disk the add hung on.
 */
async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', path], { allowExitCodes: [128] }).catch(
    () => {},
  );
  await git(repoRoot, ['worktree', 'prune'], { allowExitCodes: [128] }).catch(() => {});
  if (pointsAtWorktree(path)) rmSync(path, { recursive: true, force: true });
}

/** Whether `path` holds a linked worktree, which is what a worktree Book would be replacing. */
function pointsAtWorktree(path: string): boolean {
  return existsSync(join(path, '.git'));
}

export async function createAgentWorktree(
  snapshot: AgentSnapshot,
  agentId: string,
  worktreeRoot = defaultWorktreeRoot(),
  startCommit = snapshot.commit,
  signal?: AbortSignal,
): Promise<{ path: string; branch: string }> {
  const path = join(worktreeRoot, snapshot.repoHash, agentId);
  const branch = `book-agent/${snapshot.repoHash}/${agentId}`;
  // A worktree Book already made, and made completely, is adopted as it is, so a run that finds its
  // own directory from a previous attempt does not fail on it. Anything else at that path is git's
  // business: a file, a directory with something in it, or the remains of an add that was killed —
  // each refused by `worktree add` with a real error, which is the only outcome that says the
  // worktree does not exist rather than reporting one that does (#357).
  if (await worktreeIsComplete(path, signal)) return { path, branch };
  // Read before the add, because it is what the add's own branch is worth cleaning up: only a
  // branch that did not exist before this call is one this call created.
  const existed = await branchExists(snapshot.repoRoot, branch, signal);
  // What a previous attempt left goes first, and the branch goes with the worktree rather than with
  // the decision above. An add killed after creating the branch leaves both, and the retry is then
  // refused by "a branch named ... already exists" before it ever reaches the checkout — so a
  // half-made worktree has to take its branch with it or the next run cannot make a new one.
  //
  // Tied to the worktree on purpose: a path that is not a worktree is not Book's, and a directory
  // somebody else put there must never cost an operator the branch they made under this name. The
  // failed-add path below is the opposite case and does delete the branch on its own, because there
  // Book has just been told it created it.
  if (pointsAtWorktree(path)) {
    await removeWorktree(snapshot.repoRoot, path);
    await deleteBranchBookCreated(snapshot.repoRoot, branch, false);
  }
  mkdirSync(dirname(path), { recursive: true });
  try {
    await git(snapshot.repoRoot, ['worktree', 'add', '-b', branch, path, startCommit], { signal });
  } catch (error) {
    // A failed or aborted add can have created the worktree, its administrative directory and the
    // branch before it got to the checkout. All three go, so the next attempt is not refused by
    // "already exists" on any of them.
    await removeWorktree(snapshot.repoRoot, path);
    await deleteBranchBookCreated(snapshot.repoRoot, branch, existed);
    throw error;
  }
  if (!(await worktreeIsComplete(path, signal))) {
    // An add that reported success and left nothing usable is not a worktree to hand an agent, and
    // is removed for the same reason the failed add above is: what is left behind would be adopted
    // as a finished checkout by the next run, which is the failure this check exists to catch.
    await removeWorktree(snapshot.repoRoot, path);
    await deleteBranchBookCreated(snapshot.repoRoot, branch, existed);
    throw new Error(
      `git worktree add reported success but ${path} is not a usable worktree; it was removed so the next attempt starts clean.`,
    );
  }
  return { path, branch };
}

/**
 * Where the cleanup git runs from, which is never the directory it is deleting.
 *
 * `worktree remove` deletes the directory it is told to, and a process whose working directory is
 * a directory that is being removed is in a state the platform does not always allow to finish:
 * Windows will not delete a directory that is a process's cwd, and a `branch -D` that follows from
 * inside it fails too, which leaves the branch behind on every cleanup (#357).
 *
 * So the repository is named, not guessed: the caller's own `repoRoot` when it has one, and
 * otherwise the repository the worktree belongs to, which is outside it — its `.git` file points at
 * `<repo>/.git/worktrees/<name>`, and git runs from there as well as from `<repo>/.git`, which is
 * the directory that survives the removal the cleanup is doing. Only a worktree with no pointer left
 * is a fallback to its parent, and that is the case this is for: a directory that is no longer a
 * repository at all, where running from inside it finds nothing and both calls fail silently.
 */
function removalRoot(record: AgentRecord, repoRoot: string | undefined): string {
  if (repoRoot && resolve(repoRoot) !== resolve(record.worktree!)) return repoRoot;
  const pointed = repositoryOfWorktree(record.worktree!);
  if (pointed && existsSync(pointed)) return pointed;
  return dirname(record.worktree!);
}

/**
 * The repository a worktree belongs to, which lives outside the worktree.
 *
 * A linked worktree has no `.git` directory of its own: its `.git` is a file whose one line names
 * the administrative directory git keeps for it, `<repo>/.git/worktrees/<name>`. Reading that
 * pointer is what lets a cleanup run from the repository instead of from the checkout it is about
 * to delete. It is not the administrative directory itself that is used, because `worktree remove`
 * deletes that along with the checkout — a process whose working directory has just been removed
 * fails to start anything at all, on every platform, so the second call would never run. Two levels
 * up is `<repo>/.git` for an ordinary repository and the bare repository itself for a bare one, and
 * git resolves a repository from both.
 *
 * The pointer is not always absolute. git 2.48 writes it relative whenever the worktree is
 * somewhere the pointer can be written relative — a sibling directory, a checkout inside the
 * repository's own tree — so taking it as given resolved `<cwd>/<pointer>`, which on any other cwd
 * is a directory that does not exist, and the cleanup then ran from the worktree it was in the
 * middle of deleting (#357). git's own rule is the directory the `.git` file sits in, and
 * `resolve(worktree, gitdir)` is that rule for both forms: an absolute pointer is left exactly as
 * it is, a relative one is taken from the worktree root.
 */
function repositoryOfWorktree(worktree: string): string | undefined {
  try {
    const pointer = readFileSync(join(worktree, '.git'), 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/m.exec(pointer);
    const gitdir = match?.[1]?.trim();
    if (!gitdir) return undefined;
    return dirname(dirname(resolve(worktree, gitdir)));
  } catch {
    return undefined;
  }
}

export async function removeAgentWorktree(record: AgentRecord, repoRoot?: string): Promise<void> {
  if (!record.worktree || !record.branch) return;
  const root = removalRoot(record, repoRoot);
  await git(root, ['worktree', 'remove', '--force', record.worktree], {
    allowExitCodes: [128],
  }).catch(() => {});
  await git(root, ['branch', '-D', record.branch], { allowExitCodes: [1, 128] }).catch(() => {});
}

export async function removeSnapshotRef(snapshot: AgentSnapshot): Promise<void> {
  await git(snapshot.repoRoot, ['update-ref', '-d', snapshot.ref], { allowExitCodes: [1] }).catch(
    () => {},
  );
}

export async function checkoutAgentCommit(worktree: string, commit: string): Promise<void> {
  await git(worktree, ['reset', '--hard', commit]);
}

export async function commitAgentWork(
  record: AgentRecord,
  snapshot: AgentSnapshot,
): Promise<PatchCandidate | undefined> {
  if (!record.worktree || !record.branch) return undefined;
  await git(record.worktree, ['add', '-A', '--', '.']);
  const diff = await git(record.worktree, ['diff', ...HARDENED_DIFF_ARGS, '--cached', '--quiet'], {
    allowExitCodes: [1],
  });
  if (diff.code === 0) return undefined;
  // Belt and braces on both counts. `core.hooksPath=` already leaves `pre-commit` and `commit-msg`
  // nothing to find, and this commit is Book's work in Book's worktree rather than the
  // operator's own, so neither of them should decide whether it happens. `--no-gpg-sign` is not
  // belt and braces: `commit.gpgSign` and `gpg.program` are configuration this commit would
  // otherwise honor, and the identity it commits under — `Book Agent <agents@book.local>` — has
  // no key on any machine, so every patcher commit would fail outright, or hang a headless run on
  // pinentry, or start whatever program the configuration names. The cherry-pick that applies this
  // work to the operator's branch is a different question: that commit is the operator's own, in
  // their history, under their identity, so it still signs — and `git-signing.ts` is what decides
  // which configuration that signing reads.
  await git(
    record.worktree,
    ['commit', '--no-verify', '--no-gpg-sign', '-m', `book agent ${record.id}: ${record.name}`],
    {
      env: gitIdentityEnv(),
    },
  );
  const headCommit = (await git(record.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  return {
    baseCommit: snapshot.commit,
    headCommit,
    branch: record.branch,
    agentId: record.id,
  };
}

async function candidateDelta(
  snapshot: AgentSnapshot,
  candidate: PatchCandidate,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await git(
      snapshot.repoRoot,
      [
        'diff',
        ...HARDENED_DIFF_ARGS,
        '--binary',
        '--full-index',
        candidate.baseCommit,
        candidate.headCommit,
        '--',
      ],
      { signal },
    )
  ).stdout;
}

async function precheckDelta(
  snapshot: AgentSnapshot,
  patch: string,
  signal?: AbortSignal,
): Promise<void> {
  const index = tempIndex();
  try {
    const env = { GIT_INDEX_FILE: index.path };
    await git(snapshot.repoRoot, ['read-tree', snapshot.commit], { env, signal });
    await git(snapshot.repoRoot, ['apply', '--3way', '--check', '--cached', '-'], {
      env,
      input: patch,
      signal,
    });
    await git(snapshot.repoRoot, ['apply', '--check', '-'], { input: patch, signal });
  } finally {
    rmSync(index.dir, { recursive: true, force: true });
  }
}

/** How long the cherry-pick may take before it is killed and the pick it started is aborted. */
const CHERRY_PICK_TIMEOUT_MS = 300_000;

/**
 * Whether the repository is in the middle of a cherry-pick somebody else started.
 *
 * `CHERRY_PICK_HEAD` is git's own record of one, and `rev-parse --verify` answers "no" with exit
 * 1 rather than an error, which is why this asks for it and reads the answer rather than trusting
 * a quiet repository to mean no pick. It is checked before anything is written, and the `--abort`
 * in {@link applyVerifiedCandidate} runs only for a pick that call started.
 */
async function hasPendingCherryPick(repoRoot: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(repoRoot, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], {
    allowExitCodes: [1],
    signal,
  });
  return result.code === 0;
}

/**
 * The paths a failed cherry-pick left unmerged, which is what makes a failure a conflict.
 *
 * Read before the abort, because the abort is what removes them: afterwards there is nothing left
 * to distinguish a conflict from a signing failure that left the same `CHERRY_PICK_HEAD` behind.
 * Read with the diff drivers off, so this never starts the program a checkout names to produce it.
 */
async function unmergedPathsAfterFailure(repoRoot: string): Promise<string[]> {
  try {
    const result = await git(repoRoot, [
      'diff',
      ...HARDENED_DIFF_ARGS,
      '--name-only',
      '--diff-filter=U',
    ]);
    return result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    // A read that failed cannot say there was no conflict, and it must not turn a known failure
    // into an unknown status either: the caller reports the pick failure, and the conflict claim
    // is left out rather than invented.
    return [];
  }
}

export async function applyVerifiedCandidate(
  snapshot: AgentSnapshot,
  candidate: PatchCandidate,
  signal?: AbortSignal,
): Promise<AgentApplyResult> {
  if (candidate.baseCommit !== snapshot.commit) {
    return {
      status: 'conflicted',
      error: 'Patch candidate base does not match the task snapshot.',
    };
  }
  const actualHead = (
    await git(snapshot.repoRoot, ['rev-parse', candidate.headCommit])
  ).stdout.trim();
  if (actualHead !== candidate.headCommit) {
    return { status: 'conflicted', error: 'Patch candidate commit no longer resolves exactly.' };
  }

  // Somebody else's interrupted cherry-pick is the operator's, and it owns the working tree this
  // would write to. Book starts a cherry-pick only to be able to abort the one it started, so a
  // pick it did not start is a pick it must leave exactly as it found it.
  if (await hasPendingCherryPick(snapshot.repoRoot, signal)) {
    return {
      status: 'conflicted',
      error:
        'A cherry-pick is already in progress in this repository. Book did not start it and will not abort it; finish it (git cherry-pick --continue) or undo it (git cherry-pick --abort), then apply the agent result again.',
    };
  }

  const current = await currentWorkspaceFingerprint(
    snapshot.repoRoot,
    snapshot.includeUntracked,
    signal,
  );
  if (current !== snapshot.fingerprint) {
    return {
      status: 'conflicted',
      error: 'Parent workspace drifted after the agent snapshot; no changes were applied.',
    };
  }

  const patch = await candidateDelta(snapshot, candidate, signal);
  try {
    await precheckDelta(snapshot, patch, signal);
  } catch (error) {
    return {
      status: 'conflicted',
      error: `Patch pre-check failed; no changes were applied: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!snapshot.dirty) {
    // Signing is what this closes for the cherry-pick: it is the only call here that writes a
    // commit into the operator's history, so it is the only one that signs, and a
    // repository-local `commit.gpgSign` with a `gpg.program` of its own is a program Book would
    // start, in a flow nothing asked about (#348). The commit still signs, and signs as the
    // operator configured, because the pins carry their own value forward — see `git-signing.ts`
    // for what is read, from where, and the one signing shape that cannot be carried over.
    // Filters and merge drivers still run on this checkout, deliberately, because git-lfs depends
    // on them (#357); they are configuration a repository can own in a way signing now is not.
    //
    // The read is a separate step, before the `try` below, because it is not a cherry-pick: a
    // failure here means no pick has started, and reporting it as a rolled-back pick would be
    // wrong twice over — it would blame the pick for a read that never reached one, and the
    // `--abort` would follow to a repository that has nothing to abort.
    let signingPins: string[];
    try {
      signingPins = await signingPinArgs(snapshot.repoRoot, hardenedRunner);
    } catch (error) {
      return {
        status: 'conflicted',
        error: `Could not read the signing configuration for the cherry-pick: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      // Bounded because this is the one call that can start a program the operator named: a
      // signer waiting on a passphrase it will never be given is a hang, and an unbounded one
      // would outlive the session. The abort below then cleans up the pick this call started.
      await git(snapshot.repoRoot, [...signingPins, 'cherry-pick', candidate.headCommit], {
        timeoutMs: CHERRY_PICK_TIMEOUT_MS,
        signal,
      });
      const appliedCommit = (
        await git(snapshot.repoRoot, ['rev-parse', 'HEAD'], { signal })
      ).stdout.trim();
      return { status: 'applied', commit: appliedCommit };
    } catch (error) {
      // Read what the pick left behind before the rollback removes it, and report whether the
      // rollback actually ran: see {@link cherryPickFailureResult} for why those are two
      // questions and not one.
      const unmergedPaths = await unmergedPathsAfterFailure(snapshot.repoRoot);
      let abortError: string | undefined;
      try {
        // Exit 128 is `no cherry-pick in progress`, which for a pick that just failed is a
        // rollback that had nothing to do rather than one that failed. Anything else is a real
        // failure and is reported as one.
        await git(snapshot.repoRoot, ['cherry-pick', '--abort'], { allowExitCodes: [128] });
      } catch (abortFailure) {
        abortError = abortFailure instanceof Error ? abortFailure.message : String(abortFailure);
      }
      return cherryPickFailureResult({
        pickError: error instanceof Error ? error.message : String(error),
        abortError,
        unmergedPaths,
      });
    }
  }

  try {
    await git(snapshot.repoRoot, ['apply', '-'], { input: patch, signal });
    return { status: 'applied', commit: candidate.headCommit };
  } catch (error) {
    return {
      status: 'conflicted',
      error: `Patch application failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
