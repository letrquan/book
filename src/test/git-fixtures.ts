import { execFile } from 'child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * A commit identity and no signing on the command line, so no fixture depends on the runner's git
 * config.
 */
const IDENTITY = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgSign=false',
];

/**
 * The variables that point git at a repository other than the one in `cwd`. A suite run from a
 * git hook inherits `GIT_DIR`, and the fixtures must not write to that repository.
 */
const REPOSITORY_SELECTION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
];

/** Runs git in `cwd`, on the repository found there, and returns its stdout. */
export async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of REPOSITORY_SELECTION) delete env[name];
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8', env })).stdout;
}

/**
 * A repository at `<root>/super` with one submodule, `sub`, cloned from `<root>/sub-src`. The
 * submodule's files pass through a clean filter that writes to `marker`, so a test can tell
 * whether a status read the files inside the submodule.
 *
 * - `touch()` gives the submodule's file an older modification time, so git sees a file that may
 *   have changed and has to read it again; its content stays the same.
 * - `movePointer()` adds an empty commit in the submodule, so the commit the outer repository
 *   records for `sub` no longer matches what is checked out.
 *
 * The fixture and `movePointer()` both clear `marker` before returning, since setting up can
 * itself read the submodule's file.
 */
export async function repositoryWithSubmodule(root: string): Promise<{
  repo: string;
  marker: string;
  touch(): void;
  movePointer(): Promise<void>;
}> {
  const source = join(root, 'sub-src');
  const repo = join(root, 'super');
  const marker = join(root, 'FILTER_RAN');
  const filter = join(root, 'filter.sh');
  writeFileSync(filter, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);

  mkdirSync(source);
  await gitIn(source, 'init', '-q', '-b', 'main');
  writeFileSync(join(source, 'a.txt'), 'hi\n');
  writeFileSync(join(source, '.gitattributes'), '* filter=x\n');
  await gitIn(source, 'add', '.');
  await gitIn(source, ...IDENTITY, 'commit', '-q', '-m', 'sub');

  mkdirSync(repo);
  await gitIn(repo, 'init', '-q', '-b', 'main');
  await gitIn(repo, ...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init');
  await gitIn(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub');
  await gitIn(repo, ...IDENTITY, 'commit', '-q', '-m', 'add sub');
  const sub = join(repo, 'sub');
  await gitIn(sub, 'config', 'filter.x.clean', filter);
  rmSync(marker, { force: true });

  return {
    repo,
    marker,
    touch: () => {
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(join(sub, 'a.txt'), past, past);
    },
    movePointer: async () => {
      await gitIn(sub, ...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'moved');
      rmSync(marker, { force: true });
    },
  };
}

/**
 * A checkout at `<root>/partial` set up as a partial clone of `<root>/partial-remote`
 * (`extensions.partialClone` and `remote.origin.promisor`). With `missingTree` (the default) one
 * tree object is missing locally and the index is removed, so `git status` needs that tree;
 * without it every object is present and a plain `git status` reports a clean tree. `packs()`
 * counts the files in the checkout's pack directory, which a fetch adds to.
 */
export async function partialClone(
  root: string,
  { missingTree = true }: { missingTree?: boolean } = {},
): Promise<{ repo: string; packs(): number }> {
  const repo = join(root, 'partial');
  const remote = join(root, 'partial-remote');
  mkdirSync(join(repo, 'd'), { recursive: true });
  await gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'd', 'a.txt'), 'hi\n');
  writeFileSync(join(repo, 'top.txt'), 'top\n');
  await gitIn(repo, 'add', '.');
  await gitIn(repo, ...IDENTITY, 'commit', '-q', '-m', 'init');
  await gitIn(root, 'clone', '-q', '--bare', repo, remote);

  if (missingTree) {
    const tree = (await gitIn(repo, 'rev-parse', 'HEAD:d')).trim();
    rmSync(join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
    rmSync(join(repo, '.git', 'index'));
  }
  await gitIn(repo, 'config', 'core.repositoryformatversion', '1');
  await gitIn(repo, 'config', 'extensions.partialClone', 'origin');
  await gitIn(repo, 'config', 'remote.origin.url', remote);
  await gitIn(repo, 'config', 'remote.origin.promisor', 'true');

  return { repo, packs: () => readdirSync(join(repo, '.git', 'objects', 'pack')).length };
}
