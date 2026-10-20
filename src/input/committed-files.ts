import {
  defaultGitRunner,
  hardenedGitArgs,
  readRepositoryProgramPins,
} from '../tools/git-repository-programs.js';

/**
 * Whether a file holds exactly what the repository committed, for the mentions in a project
 * command's body (#564).
 *
 * A checked-in `.book/commands/*.md` is repository-authored text, and a mention in it would
 * otherwise inline the user's own local files into the turn: `.git/config` with a clone token,
 * `.book/settings.local.json` with a provider key, `.env`. A file git tracks with no local change
 * is already the repository's to show, so it is the only kind such a mention may inline.
 *
 * - `unchanged`: committed in `HEAD` as a regular file, the index entry is `HEAD`'s, and the file on
 *   disk hashes, through the repository's clean conversion (line endings, filters), to `HEAD`'s blob.
 *   Hashing the file rather than asking `git status` also covers an entry marked
 *   `--assume-unchanged` or `--skip-worktree`, a common way to keep local credentials in a tracked
 *   template, whose changes status does not report.
 * - `untracked`: not a regular file in `HEAD`.
 * - `changed`: committed, with a change staged or in the working tree.
 */
export type CommittedState = 'unchanged' | 'untracked' | 'changed';

/**
 * The variables that choose which repository git works on. Each outranks the directory git is
 * started in, so an exported `GIT_DIR` would have these questions answered about some other
 * repository. Unset for these calls (Node drops an `undefined` value from a child's environment).
 */
const REPOSITORY_SELECTION: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_NAMESPACE: undefined,
  GIT_PREFIX: undefined,
};

const GIT_TIMEOUT_MS = 10_000;

/** NUL-terminated `<meta>\t<path>` records, as `ls-tree -z` and `ls-files -z --stage` print them. */
function records(stdout: string): Array<{ fields: string[]; path: string }> {
  return stdout
    .split('\0')
    .filter(Boolean)
    .flatMap((record) => {
      const tab = record.indexOf('\t');
      if (tab === -1) return [];
      return [{ fields: record.slice(0, tab).split(' '), path: record.slice(tab + 1) }];
    });
}

/**
 * The state of each of `paths`, given relative to `repoRoot` with `/` separators. `repoRoot` is the
 * repository's top directory (`findRepositoryRoot`): git runs there, so it never discovers some
 * other repository above it. Each path must name an existing regular file. Git runs hardened
 * (`hardenedGitArgs`, and the repository's own filter and fsmonitor programs pinned off), with
 * literal pathspecs, and asynchronously. Rejects when any git call fails (no git, no commit yet, a
 * timeout); a caller treats that as no file being committed.
 */
export async function committedFileStates(
  repoRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, CommittedState>> {
  const states = new Map<string, CommittedState>();
  if (paths.length === 0) return states;
  const pins = await readRepositoryProgramPins(repoRoot, undefined, {
    signal,
    timeoutMs: GIT_TIMEOUT_MS,
    env: REPOSITORY_SELECTION,
  });
  const git = async (args: string[]) =>
    (
      await defaultGitRunner(hardenedGitArgs([...pins, '--literal-pathspecs', ...args]), {
        cwd: repoRoot,
        signal,
        timeoutMs: GIT_TIMEOUT_MS,
        env: REPOSITORY_SELECTION,
      })
    ).stdout;
  const [tree, index, hashes] = await Promise.all([
    git(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...paths]),
    git(['ls-files', '-z', '--stage', '--full-name', '--', ...paths]),
    git(['hash-object', '--', ...paths]),
  ]);

  // `<mode> <type> <object>`; a link (120000) or a submodule (160000) is not a committed file.
  const committed = new Map<string, string>();
  for (const { fields, path } of records(tree)) {
    if ((fields[0] === '100644' || fields[0] === '100755') && fields[1] === 'blob') {
      committed.set(path, fields[2]);
    }
  }
  // `<mode> <object> <stage>`; an unmerged path has entries at stages 1-3 and none at 0.
  const staged = new Map<string, string>();
  for (const { fields, path } of records(index)) {
    if (fields[2] === '0') staged.set(path, fields[1]);
  }
  const worktree = hashes.split(/\r?\n/);

  paths.forEach((path, position) => {
    const blob = committed.get(path);
    if (blob === undefined) states.set(path, 'untracked');
    else if (staged.get(path) !== blob || worktree[position] !== blob) states.set(path, 'changed');
    else states.set(path, 'unchanged');
  });
  return states;
}
