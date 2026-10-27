import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { resolveBookHome } from './book-home.js';
import {
  ancestorsFromRoot,
  findRepositoryRoot,
  formatSkippedNotice,
  refusalFor,
  tryRealPath,
  type SkippedProjectFile,
} from './repo-containment.js';
import { neutralizeTags } from './prompt-tags.js';
import { isOutside } from './tools/path-utils.js';
import { reachesUncPath } from './unc-path.js';

export type ProjectInstructionLayer = 'user' | 'project' | 'local' | 'rule';

export interface ProjectInstructionSource {
  path: string;
  layer: ProjectInstructionLayer;
  body: string;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A project file that was not loaded: its real path left the directory it had to stay inside
 * (`outside`), or is not a Markdown file (`not-markdown`).
 */
export type SkippedInstruction = SkippedProjectFile;

export interface ProjectInstructionInspection {
  sources: ProjectInstructionSource[];
  skipped: SkippedInstruction[];
}

/** `path` is where the file was found; `readFrom` is the real path that was checked. */
function readSource(
  path: string,
  readFrom: string,
  layer: ProjectInstructionLayer,
): ProjectInstructionSource | null {
  try {
    const body = readFileSync(readFrom, 'utf-8').trim();
    return body ? { path, layer, body } : null;
  } catch {
    return null;
  }
}

/**
 * Discovery plus the project files it refused (#539). A `project`, `local` or `rule` file found at
 * or below a git repository root loads only when its real path stays inside the real path of
 * that root and is a Markdown file: a repository can commit `CLAUDE.md` as a link to
 * `~/.ssh/id_rsa`, and the target would otherwise be sent to the provider as prompt text. A link
 * to a shared file elsewhere in the repository is fine (a monorepo package's
 * `CLAUDE.md -> ../shared/AGENTS.md`). A file in the user's home or a directory above it, when
 * that is above every repository root, is not checked: those directories belong to the user (a
 * home-manager `~/AGENTS.md` links into the Nix store). A file in any other directory above every
 * repository root, and any file when there is no repository, is checked against the directory it
 * was found in; a dotfiles `.git` in the home directory is no repository. The user
 * layer is the user's own and is never checked. Nothing is exempt by directory
 * (`~/.book/settings.json` holds the API key); a file already loaded is the only one met again
 * without a check. Discovery itself never prints.
 */
export function inspectProjectInstructions(
  workspace: string,
  homeDir?: string,
): ProjectInstructionInspection {
  const sources: ProjectInstructionSource[] = [];
  const skipped: SkippedInstruction[] = [];
  const workspaceRoot = resolve(workspace);
  const systemHome = homeDir ?? homedir();
  const bookHome = homeDir ? join(homeDir, '.book') : resolveBookHome();
  const localPath = join(workspaceRoot, 'CLAUDE.local.md');
  // Only whether the file exists matters here (an empty one is the same file as any link to it,
  // and every copy of it is skipped alike), so it is not read: `add` reads it once, below. A
  // CLAUDE.local.md that `add` is going to skip must not claim its target, or a force-added
  // `CLAUDE.local.md -> ../CLAUDE.md` would drop the ancestor's own file as well.
  const localReal = tryRealPath(localPath);
  // The directory a file found in `dir` (the workspace or one of its ancestors) must stay inside:
  // the root of the repository `dir` is in, measured per directory, so when the workspace is a
  // submodule or a worktree inside its main checkout, the outer repository's files are still
  // checked, against the outer root. `dir` itself when there is no repository up the walk at all
  // (#541). A directory in no repository while the workspace is in one is above every repository
  // root: `null` (not checked) when it is the user's home or one of its ancestors (a home-manager
  // `~/AGENTS.md` links into the Nix store), and otherwise still `dir` itself, since it may be an
  // unpacked archive whose `app/.git` makes `app` look like a root.
  // A dotfiles `.git` in the home directory is no repository (`findRepositoryRoot`).
  const workspaceRepo = findRepositoryRoot(workspaceRoot, systemHome);
  const homeReal = tryRealPath(systemHome);
  const containerFor = (dir: string): string | null => {
    const repo = findRepositoryRoot(dir, systemHome);
    if (repo !== undefined) return repo;
    if (workspaceRepo === undefined) return dir;
    const dirReal = tryRealPath(dir);
    const holdsHome =
      homeReal !== undefined && dirReal !== undefined && !isOutside(dirReal, homeReal);
    return holdsHome ? null : dir;
  };
  // Never `null` (the workspace is in its own repository or in none); `??` keeps that explicit.
  const localContainer = containerFor(workspaceRoot) ?? workspaceRoot;
  const localRootReal = tryRealPath(localContainer);
  const localKey =
    localReal !== undefined &&
    localRootReal !== undefined &&
    isFile(localReal) &&
    refusalFor(localRootReal, localReal) === undefined
      ? localReal
      : undefined;
  const loaded = new Set<string>();
  // `root` is `containerFor` of the directory the file was found in: the directory it must stay
  // inside, or `null` when it is not checked. Not given for `user`.
  const add = (path: string, layer: ProjectInstructionLayer, root?: string | null) => {
    // The user layer is never checked, so where no real path can be had it is read by name.
    const key = tryRealPath(path) ?? (layer === 'user' ? resolve(path) : undefined);
    if (key === undefined || !isFile(key)) return;
    // A file is loaded once, at its first scope. `$HOME` is an ancestor of almost every
    // workspace, so the walk below meets `~/.claude/CLAUDE.md` again, and a workspace inside
    // `BOOK_HOME` meets its `AGENTS.md`; both stay user instructions (#430). Real paths, so a
    // linked home, or a CLAUDE.md linked to the AGENTS.md beside it, counts once too.
    // The one exception to first-load-wins is CLAUDE.local.md (#524): a project-layer file that
    // is the same file (a committed `CLAUDE.md -> CLAUDE.local.md`) is the copy dropped, so the
    // file loads once, as local, after every project file, which the repository cannot then
    // override with a later `.claude/CLAUDE.md`. User-layer files are not affected.
    if (layer === 'project' && key === localKey) return;
    if (loaded.has(key)) return;
    if (layer === 'user') {
      // Loaded even when empty or unreadable, so the ancestor walk meeting `~/.claude/CLAUDE.md`
      // again as a project file does not warn about the user's own file.
      loaded.add(key);
    } else {
      if (root !== null) {
        const rootReal = root === undefined ? undefined : tryRealPath(root);
        if (rootReal === undefined) return;
        const reason = refusalFor(rootReal, key);
        if (reason) {
          skipped.push({ path, target: key, root: rootReal, reason });
          return;
        }
      }
    }
    // The real path that was just checked is the one read: no second link resolution.
    const source = readSource(path, key, layer);
    if (!source) return;
    loaded.add(key);
    sources.push(source);
  };

  add(join(systemHome, '.claude', 'CLAUDE.md'), 'user');
  add(join(bookHome, 'AGENTS.md'), 'user');

  for (const dir of ancestorsFromRoot(workspaceRoot)) {
    const root = containerFor(dir);
    add(join(dir, 'AGENTS.md'), 'project', root);
    add(join(dir, 'CLAUDE.md'), 'project', root);
    add(join(dir, '.claude', 'CLAUDE.md'), 'project', root);
  }

  add(localPath, 'local', localContainer);

  // ponytail: rules are standing guidance; add glob/frontmatter matching when path-specific activation matters.
  const rulesDir = join(workspaceRoot, '.claude', 'rules');
  try {
    // A `.claude` committed as a link to a network share is not listed: listing it would reach
    // the host (#567).
    const entries = reachesUncPath(rulesDir) ? [] : readdirSync(rulesDir, { encoding: 'utf-8' });
    for (const entry of entries.sort()) {
      if (entry.endsWith('.md')) {
        add(join(rulesDir, entry), 'rule', localContainer);
      }
    }
  } catch {
    // Missing or unreadable rules dir is fine.
  }

  return { sources, skipped };
}

export function discoverProjectInstructions(
  workspace: string,
  homeDir?: string,
): ProjectInstructionSource[] {
  return inspectProjectInstructions(workspace, homeDir).sources;
}

/**
 * One start-up warning per project file that was not loaded because it links out of the
 * repository or to a file that is not Markdown. The link is shown relative to the workspace when
 * it is inside it.
 */
export function collectSkippedInstructionNotices(workspace: string, homeDir?: string): string[] {
  return inspectProjectInstructions(workspace, homeDir).skipped.map((entry) =>
    formatSkippedNotice('project instructions', workspace, entry),
  );
}

/** The fence's own tags: a source body may hold any other markup as written. */
const FENCE_TAGS = ['project-instructions', 'source'];

/**
 * Neutralize fence markup a source file might contain. Without this a repo file
 * could close the fence early — or forge a `<source>` header — and have the rest
 * of its body read as prompt-level instruction rather than workspace policy.
 */
function neutralizeFenceTags(body: string): string {
  return neutralizeTags(body, { tags: FENCE_TAGS, style: 'entity' });
}

/**
 * Only the quote can break out of the attribute. Leave the rest of the path
 * verbatim so evaluation placeholders such as `<evaluation-workspace>` and
 * ordinary paths containing `&` stay readable.
 */
function escapeAttribute(value: string): string {
  return value.replace(/"/g, '&quot;');
}

/**
 * Wrap every source in an explicit fence. The fence, not a markdown heading, is
 * the trust boundary: injected files carry their own `#` headings, which break
 * straight out of a `## Project instructions` section.
 */
export function renderProjectInstructions(sources: ProjectInstructionSource[]): string {
  if (sources.length === 0) return '';

  const lines = [
    '## Project instructions',
    'Loaded in merge order; later sources override earlier sources.',
    '',
    '<project-instructions>',
  ];

  for (const source of sources) {
    lines.push(
      `<source path="${escapeAttribute(source.path)}" scope="${source.layer}">`,
      neutralizeFenceTags(source.body),
      '</source>',
    );
  }

  lines.push('</project-instructions>');
  return lines.join('\n');
}

// Compatibility alias for callers that imported the original CLAUDE.md-only API.
export const discoverClaudeMd = discoverProjectInstructions;
