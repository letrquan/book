import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'path';
import { resolveBookHome } from './book-home.js';
import { renderUntrustedText } from './hook-approvals.js';

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

/** A project file whose real path left the directory it was found in, so it was not loaded. */
export interface SkippedInstruction {
  /** Where the file was found. */
  path: string;
  /** Its real path. */
  target: string;
  /** The real path of the directory it had to stay inside. */
  root: string;
}

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

function tryRealPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** Compares real paths by `relative`, never a prefix: `/x/repo2` is not inside `/x/repo`. */
function isInside(rootReal: string, fileReal: string): boolean {
  const rel = relative(rootReal, fileReal);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function realPathOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function ancestorsFromRoot(workspace: string): string[] {
  const dirs: string[] = [];
  const root = parse(resolve(workspace)).root;
  let current = resolve(workspace);

  while (true) {
    dirs.push(current);
    if (current === root) break;
    current = dirname(current);
  }

  return dirs.reverse();
}

/**
 * Discovery plus the project files it refused (#539). A `project`, `local` or `rule` file loads
 * only when its real path stays inside the real path of the directory it was found in: a
 * repository can commit `CLAUDE.md` as a link to `~/.ssh/id_rsa`, and the target would otherwise
 * be sent to the provider as prompt text. The user layer is the user's own and is never checked.
 * Nothing is exempt by directory (`~/.book/settings.json` holds the API key); a file already
 * loaded is the only one met again without a check. Discovery itself never prints.
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
  // and every copy of it is skipped alike), so it is not read: `add` reads it once, below.
  const localKey = isFile(localPath) ? realPathOf(localPath) : undefined;
  const loaded = new Set<string>();
  // `root` is the directory the file was found in, which it must stay inside (not for `user`).
  const add = (path: string, layer: ProjectInstructionLayer, root?: string) => {
    const key = tryRealPath(path);
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
    if (layer !== 'user') {
      const rootReal = root === undefined ? undefined : tryRealPath(root);
      if (rootReal === undefined) return;
      if (!isInside(rootReal, key)) {
        skipped.push({ path, target: key, root: rootReal });
        return;
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
    add(join(dir, 'AGENTS.md'), 'project', dir);
    add(join(dir, 'CLAUDE.md'), 'project', dir);
    add(join(dir, '.claude', 'CLAUDE.md'), 'project', dir);
  }

  add(localPath, 'local', workspaceRoot);

  // ponytail: rules are standing guidance; add glob/frontmatter matching when path-specific activation matters.
  try {
    for (const entry of readdirSync(join(workspaceRoot, '.claude', 'rules'), {
      encoding: 'utf-8',
    }).sort()) {
      if (entry.endsWith('.md')) {
        add(join(workspaceRoot, '.claude', 'rules', entry), 'rule', workspaceRoot);
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
 * One start-up warning per project file that was not loaded because it links out of its
 * directory. The link is shown relative to the workspace when it is inside it.
 */
export function collectSkippedInstructionNotices(workspace: string, homeDir?: string): string[] {
  const workspaceRoot = resolve(workspace);
  return inspectProjectInstructions(workspace, homeDir).skipped.map((entry) => {
    const shown = isInside(workspaceRoot, entry.path)
      ? relative(workspaceRoot, entry.path)
      : entry.path;
    // The target and the names along the way are repository-authored: no control characters.
    return (
      `⚠  Skipped project instructions ${renderUntrustedText(shown, 400)}: it links to ` +
      `${renderUntrustedText(entry.target, 400)}, outside ${renderUntrustedText(entry.root, 400)}.`
    );
  });
}

/**
 * Neutralize fence markup a source file might contain. Without this a repo file
 * could close the fence early — or forge a `<source>` header — and have the rest
 * of its body read as prompt-level instruction rather than workspace policy.
 */
function neutralizeFenceTags(body: string): string {
  return body.replace(/<(\/?)(project-instructions|source)\b/gi, '&lt;$1$2');
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
