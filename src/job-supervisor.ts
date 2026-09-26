/**
 * The supervisor that keeps a persistent background job's command from outliving its runner.
 *
 * The detached job runner is the only thing that stops a command, so when the runner died any
 * other way than through a stop request (a crash, Task Manager, `kill -9`), the command kept
 * running with nothing left to stop it. On Windows the runner's death did end the shell wrapper,
 * which Node puts in a job object that dies with its parent, but not the process the wrapper had
 * started. Elsewhere the command ran in its own process group, and nothing ended it at all.
 *
 * The runner now starts this process detached, so that it outlives the runner: outside the
 * runner's job object on Windows, as the leader of its own process group elsewhere. This process
 * starts the command. Its stdin is a pipe the runner holds open and never writes, a lifeline: when
 * the runner goes away, for any reason, the operating system closes the pipe, and this process
 * ends the command's whole tree and then itself. The pipe needs no polling and cannot be fooled by
 * a reused pid. The command writes straight into the runner's own pipes, and this process exits
 * with the command's exit code, so the runner records what it always recorded. The pid Book reports
 * for the job is this process's; off Windows a signal sent to it is passed to the whole job.
 *
 * Usage, from the runner: node job-supervisor.js <spec-path>
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:os';
import { loadPersistentShellSpec } from './jobs/persistent-store.js';
import { runTaskkill, TERMINATE_GRACE_MS } from './jobs/process-tree.js';

/** Signals this process can die of just as the command did: Node gives them no meaning of its own. */
const RERAISABLE_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGKILL',
]);

const [specPath] = process.argv.slice(2);
if (!specPath) {
  process.stderr.write('Missing persistent shell specification path.\n');
  process.exit(2);
}
// The same checks the runner applies: this process starts the command, so a spec it must not
// execute is exactly as unsafe here as it is there.
const loaded = loadPersistentShellSpec(specPath);
if ('error' in loaded) {
  process.stderr.write(`${loaded.error}\n`);
  process.exit(2);
}
const spec = loaded.spec;

/**
 * The env the command is started with. This process was started without `NODE_OPTIONS`, so that the
 * options the user asked for apply to their command rather than opening an inspector here and
 * writing about it into the job's log; the runner carries them beside it for exactly that reason.
 */
function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const nodeOptions = env.BOOK_SUPERVISED_NODE_OPTIONS;
  delete env.BOOK_SUPERVISED_NODE_OPTIONS;
  if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
  return env;
}

const options: SpawnOptions = {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
  env: commandEnv(),
};
// Sandboxed specs carry an argv; only unsandboxed ones go through a shell.
const command = spec.exec
  ? spawn(spec.exec.file, spec.exec.args, { ...options, shell: false })
  : spawn(spec.effectiveCommand, { ...options, shell: true });

/** Set once the runner is gone and this process has begun ending the command's tree. */
let lifelineLost = false;

command.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  if (!lifelineLost) process.exit(1);
});

command.on('exit', (code, signal) => {
  // Once the runner is gone, this process exits when the tree has been ended, not before.
  if (lifelineLost) return;
  if (signal && process.platform !== 'win32') {
    if (RERAISABLE_SIGNALS.has(signal)) {
      // Die of the command's signal, so the runner records it the way it did before this process
      // stood between them.
      // Drop the forwarding handler, or it would swallow the re-raised signal.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      setTimeout(() => process.exit(1), 100);
      return;
    }
    // A signal Node gives a meaning of its own cannot be re-raised: SIGUSR1 would open the
    // inspector and write "Debugger listening..." into the job's log, and SIGSEGV, SIGBUS, SIGABRT
    // and SIGQUIT would dump this process's core. Report the command's death the way a shell does.
    process.exit(128 + (constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 1);
});

/**
 * Signals sent to this process, the pid Book reports for the job, are meant for the job: pass each
 * to the whole group, as the runner's own stop does, and exit with the command. Forwarded once per
 * kind, because the forwarded signal reaches this process too. Windows has no such signals; there
 * the runner's stop goes through taskkill.
 */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const forwarded = new Set<NodeJS.Signals>();
if (process.platform !== 'win32') {
  for (const kind of FORWARDED_SIGNALS) {
    process.on(kind, () => {
      if (lifelineLost || forwarded.has(kind)) return;
      forwarded.add(kind);
      try {
        process.kill(-process.pid, kind);
      } catch {
        // The group has already exited.
      }
    });
  }
}

/** How long one `taskkill` may take, and how many times it is tried before the tree is given up on. */
const TASKKILL_TIMEOUT_MS = 10_000;
const TASKKILL_ATTEMPTS = 3;

/**
 * `taskkill /T /F` on the command's tree, retried until one of them actually runs. A single attempt
 * that fails or times out leaves the command's descendants running, and here there is nobody to
 * escalate afterwards: this process is about to exit and the runner it served is already gone.
 */
async function killCommandTree(pid: number): Promise<void> {
  for (let attempt = 1; attempt <= TASKKILL_ATTEMPTS; attempt++) {
    if (await runTaskkill(pid, TASKKILL_TIMEOUT_MS)) return;
  }
}

/** The runner is gone: end the command's whole tree, then exit. */
function endCommandTree(): void {
  if (lifelineLost) return;
  lifelineLost = true;
  if (process.platform === 'win32') {
    if (command.pid === undefined) process.exit(1);
    // taskkill walks the tree from the command's root, which is still alive because this process
    // holds it. Exit only when the tree kill is done: as a child of this process, it would die with
    // it, taking the walks it had left undone with it.
    void killCommandTree(command.pid).finally(() => process.exit(1));
    return;
  }
  // This process leads the command's process group, and the group signal below reaches it too. Its
  // own SIGTERM is already spared, by the forwarding handler above returning now that the lifeline
  // is lost; that is what lets the escalation below run, and it is why nothing else has to spare it
  // a second time.
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    // The group has already exited.
  }
  // The group includes this process, so waitForProcessGroupExit could never report it empty:
  // escalate on the grace alone. SIGKILL ends this process too.
  setTimeout(() => {
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      // The group has already exited.
    }
    process.exit(1);
  }, TERMINATE_GRACE_MS);
}

process.stdin.on('end', endCommandTree);
process.stdin.on('error', endCommandTree);
process.stdin.resume();
