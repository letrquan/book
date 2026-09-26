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
 * with the command's exit code, so the runner records what it always recorded.
 *
 * Usage, from the runner: node job-supervisor.js <spec-path> <taskkill-path>
 */
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { PersistentShellSpec } from './jobs/persistent-store.js';

/** How long the command's process group gets between SIGTERM and SIGKILL, off Windows. */
const TERMINATE_GRACE_MS = 1_500;

const [specPath, taskkillPath = 'taskkill'] = process.argv.slice(2);
if (!specPath) {
  process.stderr.write('Missing persistent shell specification path.\n');
  process.exit(2);
}
let spec: PersistentShellSpec;
try {
  spec = JSON.parse(readFileSync(specPath, 'utf8')) as PersistentShellSpec;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Could not read the persistent shell specification: ${reason}\n`);
  process.exit(2);
}

const options: SpawnOptions = { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true };
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
    // Die of the command's signal, so the runner records it the way it did before this process
    // stood between them. A signal Node ignores (SIGPIPE) falls through to the exit below.
    process.kill(process.pid, signal);
    setTimeout(() => process.exit(1), 100);
    return;
  }
  process.exit(code ?? 1);
});

/** The runner is gone: end the command's whole tree, then exit. */
function endCommandTree(): void {
  if (lifelineLost) return;
  lifelineLost = true;
  if (process.platform === 'win32') {
    if (command.pid === undefined) process.exit(1);
    // taskkill walks the tree from the command's root, which is still alive because this process
    // holds it. Exit only when taskkill is done: as a child of this process, it would die with it.
    execFile(taskkillPath, ['/PID', String(command.pid), '/T', '/F'], { windowsHide: true }, () =>
      process.exit(1),
    );
    return;
  }
  // This process leads the command's process group. Spare itself the SIGTERM so it can escalate.
  process.on('SIGTERM', () => {});
  try {
    process.kill(-process.pid, 'SIGTERM');
  } catch {
    // The group has already exited.
  }
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
