import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  type Stats,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { createDebugLogger } from './debug-log.js';
import { parseFrontmatter } from './frontmatter.js';
import { writeFileAtomic } from './settings-repository.js';
import { resolveBookHome } from './book-home.js';
import { shippedHomeFiles } from './book-home-files.js';
import { DEFAULT_MAX_INDEX_LINES, MAX_INDEX_BYTES } from './memory-limits.js';
import { isUserHome, tryRealPath } from './repo-containment.js';
import { createUncGuard, type UncGuard } from './unc-path.js';
import type { SessionDriver } from './types/runtime.js';

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

export function sanitizeMemorySlug(rawSlug: string): string | null {
  const cleaned = rawSlug
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '')
    // Index entries are parsed by their `](file)` link; these must not appear in a file name.
    .replace(/[[\]()]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The last segment of a slug. Both separators are split on, so a Windows-style
 * `C:\notes\memory.md` names its file rather than being pasted onto `dir`.
 */
function lastSlugSegment(raw: string): string {
  return raw.split(/[/\\]/).pop() ?? '';
}

/**
 * Resolve a raw slug to the one file it names inside the memory directory.
 *
 * The last path segment is taken first, so a path-like slug (`memory/build-cmd.md`,
 * an absolute path) names its file instead of being pasted onto `dir`. Used by
 * `/memory delete`, which passes raw user input and gets back a resolved filename,
 * or the reason it cannot be used.
 */
export function memoryFileForSlug(
  dir: string,
  raw: string,
): { filename: string; target: string } | { error: string } {
  const cleanSlug = sanitizeMemorySlug(lastSlugSegment(raw.trim()));
  if (!cleanSlug) return { error: 'Invalid memory slug.' };
  const filename = cleanSlug.toLowerCase().endsWith('.md') ? cleanSlug : `${cleanSlug}.md`;
  if (filename.toLowerCase() === INDEX_FILE.toLowerCase()) {
    return { error: 'Target filename cannot be the index file.' };
  }
  const target = join(dir, filename);
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { error: 'Target path must stay inside the project memory directory.' };
  }
  return { filename, target };
}

/**
 * What the model may write to memory in this session — the one rule the prompt, the guard and
 * `/memory status` all read:
 *
 * - `none`: the settings turn model writes off.
 * - `learnings`: another agent drives the session. Its task prompt is that agent's per-task
 *   contract — saving from it is how a spec's "Ground rules" became permanent repository memory —
 *   but what the run learned by doing the work (a decision and its reason, an outcome with a
 *   lesson, a verified fact) is worth keeping. So only `project` and `reference` memories, marked
 *   `driver: agent`, and only delegated files may be changed or deleted.
 * - `full`: a person drives it.
 */
export type MemoryWriteScope = 'none' | 'learnings' | 'full';

export function memoryWriteScope(config: {
  settings?: { memory?: { enabled?: boolean; autoSave?: boolean } };
  sessionDriver?: SessionDriver;
}): MemoryWriteScope {
  const memory = config.settings?.memory;
  if (memory && (memory.enabled === false || memory.autoSave === false)) return 'none';
  return config.sessionDriver === 'agent' ? 'learnings' : 'full';
}

export interface MemoryFileSummary {
  name: string;
  path: string;
  type?: MemoryType;
  title?: string;
  /** The frontmatter `description`: what the memory is for, in a line. */
  description?: string;
  size: number;
  driver?: SessionDriver;
  /**
   * The file still carries the retired `status: superseded` frontmatter of the old save tool. It
   * is no longer retired by anything, so it loads like any other file; `/memory status` lists it
   * as legacy.
   */
  legacySuperseded?: boolean;
}

export interface LoadedMemoryContext {
  dir: string;
  indexFile: string | null;
  indexLoaded: boolean;
  /** Non-empty lines in MEMORY.md (the whole file, not only what loaded). */
  indexLineCount: number;
  /** Non-empty lines that loaded, the cut marker excluded. */
  loadedLineCount: number;
  /** UTF-8 size of the trimmed MEMORY.md. */
  indexByteCount: number;
  /** The index was cut at the line limit. */
  wasLineTruncated: boolean;
  /** The index was cut at the byte limit. */
  wasByteTruncated: boolean;
  /** The loaded index; ends with a warning marker when it was cut. */
  indexText: string;
  files: MemoryFileSummary[];
}

export interface MemoryStoreOptions {
  bookRoot?: string;
  maxIndexLines?: number;
}

export { DEFAULT_MAX_INDEX_LINES, MAX_INDEX_BYTES };
const INDEX_FILE = 'MEMORY.md';
// Only the move from the old cwd-keyed directory still knows these: an existing inbox is carried
// over untouched, and left for the migration to back up.
const INBOX_DIR = '.inbox';
const DISCARDED_DIR = 'discarded';

export function slugifyWorkspace(workspace: string): string {
  return (
    workspace
      .replace(/[/\\:]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  );
}

function bookRoot(opts?: MemoryStoreOptions): string {
  return opts?.bookRoot ?? resolveBookHome();
}

const log = createDebugLogger('memory-store');

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** The file-system path as the walk and the key see it: absolute, links followed when it exists. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** `lstat` without following links; null when the path is absent. Other errors throw. */
function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if (errorCode(e) === 'ENOENT' || errorCode(e) === 'ENOTDIR') return null;
    throw e;
  }
}

function statIfPresent(path: string): Stats | null {
  try {
    return statSync(path);
  } catch (e) {
    if (errorCode(e) === 'ENOENT' || errorCode(e) === 'ENOTDIR') return null;
    throw e;
  }
}

/** Git's pointer files (`.git`, `commondir`, `gitdir`) hold one path; a bigger file is none. */
const MAX_POINTER_FILE_BYTES = 64 * 1024;

/**
 * The first line of the git pointer file `path`, trimmed; undefined when it is absent or no
 * regular file. A checkout from an archive controls these files, so the read never blocks or
 * runs on: it opens without blocking (a FIFO, even one swapped in late), checks the open file,
 * and reads at most one byte past the limit (a procfs file reports size 0 and never ends).
 * Throws on one it cannot read or that is too big. Undefined, unopened, for one that is, or
 * reaches through a link, a UNC location on Windows (`reachesUnc`, #579).
 */
function readPointerFile(path: string, reachesUnc: UncGuard): string | undefined {
  if (reachesUnc(path)) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(MAX_POINTER_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > MAX_POINTER_FILE_BYTES) throw new Error(`not a git pointer file: ${path}`);
    return buffer.toString('utf-8', 0, length).split(/\r?\n/, 1)[0].trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * The git root `dir` itself marks with a `.git` entry; undefined when `dir` has none. Throws on a
 * `.git` it cannot read, and on one that is, or reaches through a link, a UNC location on Windows,
 * which is not opened (#579). A git dir or common dir there is not opened either: `dir` is then
 * its own root, as a checkout with no common dir is.
 */
function gitRootMarkedBy(dir: string, reachesUnc: UncGuard): string | undefined {
  const dotGit = join(dir, '.git');
  if (reachesUnc(dotGit)) throw new Error(`.git on a UNC path: ${dotGit}`);
  const st = statIfPresent(dotGit);
  if (!st) return undefined;
  if (st.isDirectory()) return dir;
  if (!st.isFile()) return undefined;

  const pointer = /^gitdir:[ \t]*(\S.*)$/.exec(readPointerFile(dotGit, reachesUnc) ?? '');
  if (!pointer) throw new Error(`unrecognized .git file: ${dotGit}`);
  // A relative gitdir resolves against the directory holding the `.git` file.
  const gitDir = resolve(dir, pointer[1]);
  if (reachesUnc(gitDir)) return dir;
  const commonDir = readPointerFile(join(gitDir, 'commondir'), reachesUnc);
  // A submodule or `--separate-git-dir` checkout has no commondir: it is its own root.
  if (commonDir === undefined) return dir;
  const commonPath = resolve(gitDir, commonDir);
  if (reachesUnc(commonPath)) return dir;
  const common = canonicalPath(commonPath);
  // A linked worktree's common dir is the main checkout's `.git`, which lists the worktree back.
  return basename(common) === '.git' && isListedWorktree(dir, gitDir, common, reachesUnc)
    ? dirname(common)
    : dir;
}

/**
 * The real path to compare, links followed and Windows 8.3 short names expanded as git writes
 * them. Only for comparing: the key itself stays `canonicalPath`'s, so no stored key changes.
 */
function comparablePath(path: string): string {
  return tryRealPath(path) ?? resolve(path);
}

/** Whether `a` and `b` name one path; `relative`, so case folds where the platform's paths do (Windows). */
function samePath(a: string, b: string): boolean {
  return relative(comparablePath(a), comparablePath(b)) === '';
}

/**
 * Whether the repository at `common` lists `dir` as one of its linked worktrees, git's own round
 * trip: the git dir `dir/.git` names must be an entry `<common>/worktrees/<name>`, and that entry's
 * `gitdir` file must name `dir/.git` back. Without it a `.git` file anywhere (an archive, a shared
 * directory) could name another project's `.git`, the home directory's included, and take that
 * project's memory (#575). A worktree moved without `git worktree move` fails it until
 * `git worktree repair` relinks it.
 *
 * Stricter than git's own pointers: `dir/.git` and the entry's `gitdir` must have one owner, as
 * every `git worktree add`, `move` and `repair` writes both. Another user's `.git` planted where a
 * removed worktree's still-listed path was (a shared directory, `/tmp`) fails it. Windows reports
 * uid 0 for every file, so there the owners always match.
 */
function isListedWorktree(
  dir: string,
  gitDir: string,
  common: string,
  reachesUnc: UncGuard,
): boolean {
  const entry = comparablePath(gitDir);
  if (!samePath(dirname(entry), join(common, 'worktrees'))) return false;
  const listing = join(entry, 'gitdir');
  try {
    const backPointer = readPointerFile(listing, reachesUnc);
    if (!backPointer) return false;
    // A relative back-pointer (`worktree.useRelativePaths`) resolves against the entry.
    const target = resolve(entry, backPointer);
    // The directories are compared, not the `.git` entries: a `.git` link in another directory to
    // a real worktree's `.git` file makes that directory no worktree.
    if (basename(target) !== '.git' || !samePath(dirname(target), dir)) return false;
    return lstatSync(join(dir, '.git')).uid === statSync(listing).uid;
  } catch {
    // An entry it cannot read lists nothing, so every subdirectory keys by this checkout alike.
    return false;
  }
}

/**
 * The directory memory is keyed by: the git repository root the workspace belongs to, so every
 * subdirectory and every linked worktree of one repository shares one memory. Only reads files
 * (never spawns git). Falls back to the resolved workspace when there is no repository, or when
 * the walk meets anything it cannot read.
 *
 * A `.git` file maps to the main checkout only for a linked worktree the main checkout lists
 * back (`isListedWorktree`); any other is its own root.
 *
 * A `.git` at the user's home directory is a dotfiles repository, not a project
 * (`findRepositoryRoot` in `repo-containment.ts`): the walk stops there with no repository, so
 * each project under the home directory without its own `.git` keeps its own memory instead of
 * sharing the home directory's. Memory already stored under the home directory's key stays
 * there.
 */
export function findGitRoot(workspace: string): string {
  // A workspace that is, or reaches through a link, a UNC location on Windows is neither resolved
  // nor walked up (#579): it is its own key, as written. One guard serves the whole walk up.
  const reachesUnc = createUncGuard();
  if (reachesUnc(workspace)) return resolve(workspace);
  const resolved = canonicalPath(workspace);
  try {
    for (let dir = resolved; ;) {
      const root = gitRootMarkedBy(dir, reachesUnc);
      if (root !== undefined) {
        return isUserHome(tryRealPath(dir) ?? dir, undefined) ? resolved : root;
      }
      const parent = dirname(dir);
      if (parent === dir) return resolved;
      dir = parent;
    }
  } catch {
    return resolved;
  }
}

function memoryDirIn(root: string, workspaceKey: string): string {
  return join(root, 'projects', slugifyWorkspace(workspaceKey), 'memory');
}

export function getProjectMemoryDir(workspace: string, opts?: MemoryStoreOptions): string {
  return memoryDirIn(bookRoot(opts), findGitRoot(workspace));
}

/**
 * Whether the workspace's repository ships files in the memory tree under Book's home
 * (`book-home-files.ts`): memory there is the repository's, so none of it is loaded or migrated.
 */
export function isShippedMemoryTree(workspace: string, opts?: MemoryStoreOptions): boolean {
  const root = bookRoot(opts);
  return shippedHomeFiles(workspace, root)?.shipsAnyUnder(join(root, 'projects')) ?? false;
}

/** Link `src` to `dst` without replacing `dst`, then drop `src`. A race lost to another process is not an error. */
function moveFileNoClobber(src: string, dst: string): 'moved' | 'exists' | 'gone' {
  try {
    linkSync(src, dst);
  } catch (e) {
    if (errorCode(e) === 'EEXIST') return 'exists';
    if (errorCode(e) === 'ENOENT' && !lstatIfPresent(src)) return 'gone';
    // Hard links unsupported here (EPERM, EXDEV, ...): copy exclusively instead.
    try {
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if (errorCode(copyError) === 'EEXIST') return 'exists';
      if (errorCode(copyError) === 'ENOENT' && !lstatIfPresent(src)) return 'gone';
      throw copyError;
    }
  }
  try {
    unlinkSync(src);
  } catch (e) {
    if (errorCode(e) !== 'ENOENT') throw e;
  }
  return 'moved';
}

/** Move `dir/name` into `target`, suffixing `-2`, `-3`, … before `.md` on a collision. Returns the final name, or null when the source vanished. */
function moveKeepingBoth(sourceDir: string, targetDir: string, name: string): string | null {
  const stem = name.slice(0, -'.md'.length);
  for (let n = 1; n <= 1000; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}.md`;
    const outcome = moveFileNoClobber(join(sourceDir, name), join(targetDir, candidate));
    if (outcome === 'moved') return candidate;
    if (outcome === 'gone') return null;
  }
  throw new Error(`too many name collisions moving ${name}`);
}

/** True when `path` is a real directory (created when absent); a symlink or file there is never followed. */
function ensureRealDir(path: string): boolean {
  const st = lstatIfPresent(path);
  if (!st) {
    mkdirSync(path, { recursive: true });
    return true;
  }
  return st.isDirectory();
}

function isMemoryTopicFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') && lower !== INDEX_FILE.toLowerCase();
}

/** The regular `*.md` files directly in `dir` (symlinks excluded). */
function regularMarkdownFiles(dir: string, accept: (name: string) => boolean): string[] {
  const st = lstatIfPresent(dir);
  if (!st?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Move the old index's entry lines into the new index, right after its header. */
function mergeLegacyIndex(oldDir: string, newDir: string, renamed: Map<string, string>): void {
  const oldIndex = join(oldDir, INDEX_FILE);
  if (!lstatIfPresent(oldIndex)?.isFile()) return;
  const newIndexStat = lstatIfPresent(join(newDir, INDEX_FILE));
  if (newIndexStat && !newIndexStat.isFile()) return;

  let oldText: string;
  try {
    oldText = readFileSync(oldIndex, 'utf-8');
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return; // another process merged it
    throw e;
  }
  const lines = readIndexLines(newDir);
  const listed = new Set<string>();
  for (const line of lines) {
    const file = indexEntryFile(line);
    if (file) listed.add(file.toLowerCase());
  }
  const additions: string[] = [];
  for (const line of oldText.split('\n')) {
    const file = indexEntryFile(line);
    if (!file) continue;
    const target = renamed.get(file) ?? file;
    if (listed.has(target.toLowerCase())) continue;
    listed.add(target.toLowerCase());
    additions.push(target === file ? line : line.replace(`](${file})`, `](${target})`));
  }
  if (additions.length > 0) {
    const merged =
      lines.length === 0
        ? ['# Book memory index', ...additions]
        : lines[0].startsWith('#')
          ? [lines[0], ...additions, ...lines.slice(1)]
          : [...additions, ...lines];
    writeIndexLines(newDir, merged);
  }
  try {
    unlinkSync(oldIndex);
  } catch (e) {
    if (errorCode(e) !== 'ENOENT') throw e;
  }
}

function mergeLegacyMemoryDir(oldDir: string, newDir: string): void {
  const renamed = new Map<string, string>();
  for (const name of regularMarkdownFiles(oldDir, isMemoryTopicFile)) {
    const final = moveKeepingBoth(oldDir, newDir, name);
    if (final && final !== name) renamed.set(name, final);
  }
  for (const sub of [INBOX_DIR, join(INBOX_DIR, DISCARDED_DIR)]) {
    const files = regularMarkdownFiles(join(oldDir, sub), (name) =>
      name.toLowerCase().endsWith('.md'),
    );
    if (files.length === 0) continue;
    // `.inbox` and `.inbox/discarded` are checked one by one: neither may be a link.
    const targetDir = join(newDir, sub);
    if (!ensureRealDir(join(newDir, INBOX_DIR)) || !ensureRealDir(targetDir)) continue;
    for (const name of files) moveKeepingBoth(join(oldDir, sub), targetDir, name);
  }
  mergeLegacyIndex(oldDir, newDir, renamed);
  // Best effort: only an empty directory goes. The old extraction state and lock files stay, so
  // the old directory is usually left holding just those.
  for (const leftover of [
    join(oldDir, INBOX_DIR, DISCARDED_DIR),
    join(oldDir, INBOX_DIR),
    oldDir,
  ]) {
    try {
      if (lstatIfPresent(leftover)?.isDirectory()) rmdirSync(leftover);
    } catch {
      // not empty, or already gone
    }
  }
}

/** Best effort: remove the old `projects/<slug>/` directory when it is a real, empty directory. */
function removeEmptyLegacyProjectDir(projectDir: string): void {
  try {
    if (lstatIfPresent(projectDir)?.isDirectory()) rmdirSync(projectDir);
  } catch {
    // not empty, or already gone
  }
}

/**
 * Memory used to be keyed by the workspace string as given. Move that directory to the git-root
 * key: rename it when the new one is absent, otherwise merge (both copies of a colliding name are
 * kept). Never follows a symlink; never throws — a failure is logged and the session continues
 * with the new directory.
 */
export function migrateLegacyMemoryDir(workspace: string, opts?: MemoryStoreOptions): void {
  try {
    const legacySlug = slugifyWorkspace(workspace);
    if (legacySlug === '.' || legacySlug === '..') return;
    const oldDir = memoryDirIn(bookRoot(opts), workspace);
    const newDir = getProjectMemoryDir(workspace, opts);
    if (oldDir === newDir) return;
    if (!lstatIfPresent(oldDir)?.isDirectory()) return; // absent, a file, or a symlink

    if (!lstatIfPresent(newDir)) {
      mkdirSync(dirname(newDir), { recursive: true });
      try {
        renameSync(oldDir, newDir);
        removeEmptyLegacyProjectDir(dirname(oldDir));
        return;
      } catch (e) {
        const code = errorCode(e);
        if (code === 'ENOENT' && !lstatIfPresent(oldDir)) return; // another process moved it
        // The new directory appeared meanwhile: merge into it below.
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOENT') throw e;
      }
    }
    if (!lstatIfPresent(newDir)?.isDirectory()) return;
    mergeLegacyMemoryDir(oldDir, newDir);
    removeEmptyLegacyProjectDir(dirname(oldDir));
  } catch (e) {
    log.warn('memory move from the old directory failed', e);
  }
}

// -- the one-time move from the old file layout -------------------------------------------------

/** Written once a directory is in the current layout; its content is the layout's version. */
const FORMAT_FILE = '.format';
const FORMAT_VERSION = '2';
const BACKUP_PREFIX = 'memory.legacy-';
const BACKUP_NAME = /^memory\.legacy-(\d{8})(?:-(\d+))?$/;
const SLUG_MAX = 60;
/** A converted file's frontmatter `description`. */
const DESCRIPTION_MAX = 150;
/** A converted index line, link included; longer than this is too long to scan. */
const INDEX_LINE_MAX = 200;
const TITLE_MAX = 120;
const DROPPED_STATUSES = new Set(['superseded', 'pending', 'discarded']);

/** What the old inbox and extraction left in the directory. */
const isLegacyLeftover = (name: string): boolean =>
  name === INBOX_DIR || /^\.extraction[-.]/.test(name);

interface LegacyFile {
  /** The top-level frontmatter keys, values as written (trimmed). */
  keys: Map<string, string>;
  /** The lines under each key that are not a `key:` line of their own (a list's items). */
  extra: Map<string, string[]>;
  body: string;
}

/**
 * The frontmatter of a memory file as the old layout wrote it: only keys at column 0 count, so a
 * current file's `metadata.type` is not mistaken for a legacy top-level `type`.
 */
function parseLegacyFile(text: string): LegacyFile | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return null;
  const close = lines.indexOf('---', 1);
  if (close < 0) return null;
  const keys = new Map<string, string>();
  const extra = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines.slice(1, close)) {
    const key = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (key) {
      current = key[1];
      keys.set(current, key[2].trim());
      extra.set(current, []);
    } else if (current && line.trim() !== '' && !line.startsWith('#')) {
      extra.get(current)?.push(line);
    }
  }
  return { keys, extra, body: lines.slice(close + 1).join('\n') };
}

const unquote = (value: string): string => value.replace(/^(["'])(.*)\1$/, '$2').trim();

const stripControls = (text: string): string => text.replace(/[\x00-\x1f\x7f]/g, '').trim();

/**
 * `text` shortened to at most `max` characters, ending with `…` when anything was cut. The cut
 * is only ever between words, and never inside a backtick code span: a cut that lands in an
 * unclosed span backs up to before its opening backtick. When no whole word fits (one long word)
 * the result is just `…`; a half word would say less than nothing.
 */
export function shortenAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 1) return '';
  let end = max - 1; // room for the ellipsis
  for (;;) {
    const atBoundary = end === 0 || /\s/.test(text[end]) || /\s/.test(text[end - 1]);
    if (!atBoundary) {
      end = Math.max(0, text.slice(0, end).search(/\s\S*$/));
      continue;
    }
    const ticks = text.slice(0, end).split('`').length - 1;
    if (ticks % 2 === 1) {
      end = text.lastIndexOf('`', end - 1);
      continue;
    }
    break;
  }
  const kept = text.slice(0, end).trimEnd();
  return `${kept}…`;
}

/** A YAML plain scalar when `value` is safe as one, otherwise a double-quoted one. */
function yamlValue(value: string): string {
  const risky =
    value === '' ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:(\s|$)|\s#|\s$/.test(value) ||
    /^(?:true|false|null|yes|no|on|off|~|[-+]?[\d.]+)$/i.test(value);
  return risky ? JSON.stringify(value) : value;
}

/** A kebab-case slug cut to `max` characters at a `-` (a lone longer word is cut hard). */
function capSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const whole = slug[max] === '-' ? cut : cut.slice(0, Math.max(cut.lastIndexOf('-'), 0) || max);
  return whole.replace(/-+$/, '');
}

function kebabSlug(text: string): string {
  return capSlug(
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
    SLUG_MAX,
  );
}

/** What is left of `YYYY-MM-DD-<type>-<title>-<hash>.md` without the date, type and hash. */
function titleFromLegacyName(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/^(?:user|feedback|project|reference)-/, '')
    .replace(/-(?=[a-f]*\d)[0-9a-f]{6,12}$/, '')
    .replace(/-+/g, ' ')
    .trim();
}

const OLD_ENTRY_TAIL = /^\s*—\s*[^—]*?\s*—\s*\d{4}-\d{2}-\d{2}(?:\s*—\s*(.*))?$/;

/** An old index line (`- [Title](file) — type — YYYY-MM-DD — hook`), as its target and hook. */
function parseIndexEntry(line: string): { target: string; hook: string; old: boolean } | null {
  const entry = /^- \[[^\]]*\]\(([^()]+)\)(.*)$/.exec(line);
  if (!entry) return null;
  const target = entry[1].replace(/^\.\//, '').toLowerCase();
  const old = OLD_ENTRY_TAIL.exec(entry[2]);
  if (old) return { target, hook: old[1] ?? '', old: true };
  return { target, hook: entry[2].replace(/^\s*—\s*/, ''), old: false };
}

/**
 * `- [Title](file) — hook`, at most `INDEX_LINE_MAX` characters: the title stays whole (up to
 * `TITLE_MAX`) and the hook gives way first; a title the link leaves no room for is shortened and
 * the hook dropped.
 */
function indexLine(title: string, file: string, description: string): string {
  const plain = title.replace(/[[\]()]/g, '').trim() || file;
  const linkCost = 6 + file.length; // `- [` + `](` + `)` around the file name
  let shown = shortenAtWord(plain, Math.min(TITLE_MAX, INDEX_LINE_MAX - linkCost));
  if (shown === '…') shown = file;
  const head = `- [${shown}](${file})`;
  const room = INDEX_LINE_MAX - head.length - 3;
  const hook = room > 1 ? shortenAtWord(description, room) : '';
  return hook && hook !== '…' ? `${head} — ${hook}` : head;
}

interface ConvertedMemory {
  oldName: string;
  slug: string;
  title: string;
  description: string;
  content: string;
  modifiedMs: number;
}

function legacyModifiedMs(file: LegacyFile, name: string, mtimeMs: number): number {
  const stamped = Date.parse(unquote(file.keys.get('updated') || file.keys.get('created') || ''));
  if (!Number.isNaN(stamped)) return stamped;
  const named = Date.parse(/^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? '');
  return Number.isNaN(named) ? mtimeMs : named;
}

/** The current-layout text of one legacy file, with the title and description it was given. */
function convertLegacyFile(
  name: string,
  file: LegacyFile,
  hook: string | undefined,
  slug: (title: string) => string,
  mtimeMs: number,
): ConvertedMemory {
  const lines = file.body.split('\n');
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  let heading: string | undefined;
  if (start < lines.length && /^#\s+\S/.test(lines[start])) {
    heading = lines[start]
      .replace(/^#\s+/, '')
      .replace(/^Candidate:\s*/i, '')
      .trim();
    start++;
  }
  const body = lines
    .slice(start)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd();
  const title = heading || titleFromLegacyName(name) || 'Memory';
  const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? '';
  const description = shortenAtWord(
    stripControls(hook ?? '') || stripControls(firstLine) || stripControls(title),
    DESCRIPTION_MAX,
  );
  const finalSlug = slug(title);

  const value = (key: string): string => unquote(file.keys.get(key) ?? '');
  const meta: string[] = [];
  if (value('type')) meta.push(`  type: ${yamlValue(value('type'))}`);
  if (value('sessionId')) meta.push(`  originSessionId: ${yamlValue(value('sessionId'))}`);
  const modified = value('updated') || value('created');
  if (modified) meta.push(`  modified: ${yamlValue(modified)}`);
  if (value('driver') === 'agent') meta.push('  driver: agent');
  const evidence = file.keys.get('evidence') ?? '';
  const evidenceLines = file.extra.get('evidence') ?? [];
  if (evidence !== '') {
    meta.push(`  evidence: ${evidence}`);
  } else if (evidenceLines.length > 0) {
    meta.push('  evidence:');
    for (const line of evidenceLines) {
      const item = /^\s*-\s+(.*)$/.exec(line)?.[1]?.trim();
      meta.push(
        item === undefined
          ? `  ${line}`
          : `    - ${/^(["']).*\1$/.test(item) ? item : yamlValue(item)}`,
      );
    }
  }

  const content =
    [
      '---',
      `name: ${finalSlug}`,
      `description: ${yamlValue(description)}`,
      ...(meta.length > 0 ? ['metadata:', ...meta] : []),
      '---',
      ...(body ? [body] : []),
    ].join('\n') + '\n';
  return {
    oldName: name,
    slug: finalSlug,
    title,
    description,
    content,
    modifiedMs: legacyModifiedMs(file, name, mtimeMs),
  };
}

function localDateStamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** Copy the regular files and directories under `source`; a link is never followed, nor copied. */
function copyTreeWithoutLinks(source: string, target: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to);
      copyTreeWithoutLinks(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    }
  }
}

/** Copy `dir` to a fresh `memory.legacy-<YYYYMMDD>[-n]` beside it; throws, leaving nothing behind, on failure. */
function backUpMemoryDir(dir: string): string {
  const stamp = localDateStamp(new Date());
  for (let n = 1; n <= 1000; n++) {
    const target = join(dirname(dir), `${BACKUP_PREFIX}${stamp}${n === 1 ? '' : `-${n}`}`);
    try {
      mkdirSync(target);
    } catch (e) {
      if (errorCode(e) === 'EEXIST') continue;
      throw e;
    }
    try {
      copyTreeWithoutLinks(dir, target);
      return target;
    } catch (e) {
      rmSync(target, { recursive: true, force: true });
      throw e;
    }
  }
  throw new Error('too many memory backups for one day');
}

/** The newest `memory.legacy-*` backup beside `dir`, or null when the migration left none. */
export function findLegacyMemoryBackup(dir: string): string | null {
  try {
    const found = readdirSync(dirname(dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && BACKUP_NAME.test(entry.name))
      .map((entry) => {
        const [, date, n] = BACKUP_NAME.exec(entry.name) ?? [];
        return { name: entry.name, date, n: Number(n ?? 1) };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.n - b.n);
    const newest = found.at(-1);
    return newest ? join(dirname(dir), newest.name) : null;
  } catch {
    return null;
  }
}

export function legacyBackupNotice(backup: string): string {
  return `Migrated to the new memory format; the old files are in ${backup}.`;
}

/** The new MEMORY.md: hand-written lines kept, then one pointer line per converted file. */
function migratedIndexLines(
  oldText: string | null,
  converted: ConvertedMemory[],
  droppedNames: Set<string>,
): string[] {
  const byTarget = new Map(converted.map((c) => [`${c.slug}.md`, c]));
  // An old name that is also a new slug is the same file, converted in place.
  for (const c of converted) byTarget.set(c.oldName.toLowerCase(), c);
  const kept: string[] = [];
  const ordered: ConvertedMemory[] = [];
  for (const raw of oldText?.split('\n') ?? []) {
    const line = raw.replace(/\r$/, '');
    if (/^#\s*Book memory index\s*$/i.test(line)) continue;
    const entry = parseIndexEntry(line);
    if (!entry) {
      kept.push(line);
      continue;
    }
    const match = byTarget.get(entry.target);
    if (match) {
      if (!ordered.includes(match)) ordered.push(match);
    } else if (!droppedNames.has(entry.target) && !entry.old) {
      kept.push(line);
    }
  }
  const missing = converted
    .filter((c) => !ordered.includes(c))
    .sort((a, b) => b.modifiedMs - a.modifiedMs || b.oldName.localeCompare(a.oldName));

  const tidy: string[] = [];
  for (const line of kept) {
    if (line.trim() === '' && (tidy.length === 0 || tidy[tidy.length - 1].trim() === '')) continue;
    tidy.push(line);
  }
  while (tidy.length > 0 && tidy[tidy.length - 1].trim() === '') tidy.pop();
  return [
    ...tidy,
    ...[...ordered, ...missing].map((c) => indexLine(c.title, `${c.slug}.md`, c.description)),
  ];
}

function migrateFormat(dir: string): void {
  if (!lstatIfPresent(dir)?.isDirectory()) return; // absent, a file, or a link: never followed
  const marker = join(dir, FORMAT_FILE);
  if (lstatIfPresent(marker)?.isFile() && readFileSync(marker, 'utf-8').trim() === FORMAT_VERSION) {
    return;
  }

  // Detect. Links are skipped throughout: nothing is read, converted or removed through one.
  const everything = readdirSync(dir, { withFileTypes: true });
  const entries = everything.filter((e) => !e.isSymbolicLink());
  const leftovers = entries.filter((e) => isLegacyLeftover(e.name)).map((e) => e.name);
  const legacy: Array<{ name: string; file: LegacyFile; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !isMemoryTopicFile(entry.name)) continue;
    const path = join(dir, entry.name);
    const file = parseLegacyFile(readFileSync(path, 'utf-8'));
    if (file && (file.keys.has('status') || file.keys.has('type'))) {
      legacy.push({ name: entry.name, file, mtimeMs: statSync(path).mtimeMs });
    }
  }
  if (legacy.length === 0 && leftovers.length === 0) {
    writeFileAtomic(marker, `${FORMAT_VERSION}\n`);
    return;
  }

  // Everything is read before the backup, and the backup is made before anything changes.
  const indexPath = join(dir, INDEX_FILE);
  const indexStat = lstatIfPresent(indexPath);
  const oldIndex = indexStat?.isFile() ? readFileSync(indexPath, 'utf-8') : null;
  const hooks = new Map<string, string>();
  for (const line of oldIndex?.split('\n') ?? []) {
    const entry = parseIndexEntry(line.replace(/\r$/, ''));
    if (entry && !hooks.has(entry.target)) hooks.set(entry.target, entry.hook);
  }
  const backup = backUpMemoryDir(dir);
  log.info(`memory backed up to ${backup}`);

  // Every name in the directory is taken (a file never lands on another's name), and so is
  // MEMORY.md on a case-insensitive file system.
  const taken = new Set(everything.map((e) => e.name.toLowerCase()));
  taken.add(INDEX_FILE.toLowerCase());
  const converted: ConvertedMemory[] = [];
  const dropped = new Set<string>();
  for (const { name, file, mtimeMs } of legacy.sort((a, b) => a.name.localeCompare(b.name))) {
    const status = unquote(file.keys.get('status') ?? '').toLowerCase();
    if (DROPPED_STATUSES.has(status)) {
      dropped.add(name.toLowerCase());
      continue;
    }
    const own = name.toLowerCase();
    const claim = (title: string): string => {
      const base =
        kebabSlug(title) ||
        kebabSlug(titleFromLegacyName(name)) ||
        kebabSlug(unquote(file.keys.get('type') ?? '')) ||
        'memory';
      for (let n = 1; ; n++) {
        const suffix = n === 1 ? '' : `-${n}`;
        const slug = `${capSlug(base, SLUG_MAX - suffix.length)}${suffix}`;
        const lower = `${slug}.md`;
        if (!taken.has(lower) || lower === own) {
          taken.add(lower);
          return slug;
        }
      }
    };
    converted.push(convertLegacyFile(name, file, hooks.get(own) || undefined, claim, mtimeMs));
  }

  for (const c of converted) {
    writeFileAtomic(join(dir, `${c.slug}.md`), c.content);
    if (`${c.slug}.md` !== c.oldName) unlinkSync(join(dir, c.oldName));
  }
  for (const name of dropped) {
    const original = legacy.find((l) => l.name.toLowerCase() === name)?.name;
    if (original) unlinkSync(join(dir, original));
  }
  for (const name of leftovers) rmSync(join(dir, name), { recursive: true, force: true });

  if (indexStat === null || indexStat.isFile()) {
    const lines = migratedIndexLines(oldIndex, converted, dropped);
    if (oldIndex !== null || lines.length > 0) {
      writeFileAtomic(indexPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    }
  } else {
    log.warn('MEMORY.md is not a regular file; it was left as it is');
  }
  writeFileAtomic(marker, `${FORMAT_VERSION}\n`);
}

/**
 * Bring a memory directory still in the old layout (`status` / `type` frontmatter, an inbox,
 * extraction state, a typed index) to the current one, once. The whole directory is copied to
 * `memory.legacy-<date>/` first; if that fails nothing is changed. Approved files become
 * `<slug>.md` with `name` / `description` / `metadata`; superseded, pending and discarded files,
 * the inbox and the extraction files are dropped (they survive only in the backup); `MEMORY.md`
 * is rewritten in the pointer format. A `.format` file records that it is done. Never throws,
 * never blocks the session: a failure is logged, and the next load tries again.
 */
export function migrateLegacyMemoryFormat(dir: string): void {
  try {
    migrateFormat(dir);
  } catch (e) {
    log.warn('memory format migration failed', e);
  }
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

function titleFromBody(body: string): string | undefined {
  const firstHeading = body.split('\n').find((line) => line.startsWith('# '));
  return firstHeading?.replace(/^#\s+/, '').trim();
}

/**
 * One file's listing entry. `parseFrontmatter` reads a nested `metadata:` block's children as
 * top-level keys, so `metadata.type` (the current layout) and a top-level `type` (the legacy
 * layout) come out as the same key.
 */
function summarizeMemoryFile(path: string, name = basename(path)): MemoryFileSummary | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const { body, frontmatter } = parseFrontmatter(readFileSync(path, 'utf-8'));
    const title =
      (typeof frontmatter.title === 'string' && frontmatter.title) ||
      titleFromBody(body) ||
      (typeof frontmatter.name === 'string' && frontmatter.name) ||
      undefined;
    return {
      name,
      path,
      type: isMemoryType(frontmatter.type) ? frontmatter.type : undefined,
      title,
      ...(typeof frontmatter.description === 'string' && frontmatter.description.trim()
        ? { description: frontmatter.description.trim() }
        : {}),
      size: st.size,
      ...(frontmatter.driver === 'agent' ? { driver: 'agent' as const } : {}),
      ...(frontmatter.status === 'superseded' ? { legacySuperseded: true as const } : {}),
    };
  } catch {
    return null;
  }
}

export function listMemoryFiles(workspace: string, opts?: MemoryStoreOptions): MemoryFileSummary[] {
  const dir = getProjectMemoryDir(workspace, opts);
  if (!existsSync(dir) || isShippedMemoryTree(workspace, opts)) return [];
  const files: MemoryFileSummary[] = [];
  try {
    for (const entry of readdirSync(dir).sort()) {
      // MEMORY.md is the index, not a memory file; a dot-entry is not one either.
      if (entry.startsWith('.') || !isMemoryTopicFile(entry)) continue;
      const summary = summarizeMemoryFile(join(dir, entry), entry);
      if (summary) files.push(summary);
    }
  } catch {
    return files;
  }
  return files;
}

interface IndexLoad {
  /** What loads: the kept text, then a blank line and the warning marker when anything was cut. */
  text: string;
  /** Non-empty lines in the whole index. */
  totalLines: number;
  /** Non-empty lines kept. */
  loadedLines: number;
  /** UTF-8 size of the trimmed index. */
  byteCount: number;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
}

const formatCount = (n: number): string => n.toLocaleString('en-US');

function countNonEmptyLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * What the model gets of MEMORY.md: the first `maxLines` lines, then cut again at the last
 * newline within `MAX_INDEX_BYTES` (at the last whole character when line 1 alone is longer).
 * The cut drops the end of the file, and the marker says so instead of letting entries vanish
 * silently.
 */
function cutIndex(raw: string, maxLines: number): IndexLoad {
  const trimmed = raw.trim();
  const byteCount = Buffer.byteLength(trimmed);
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const wasLineTruncated = lines.length > maxLines;
  let kept = wasLineTruncated ? lines.slice(0, maxLines).join('\n') : trimmed;
  let keptLineCount = Math.min(lines.length, maxLines);
  let wasByteTruncated = false;
  let bytesKeptOfLine1: number | undefined;

  if (Buffer.byteLength(kept) > MAX_INDEX_BYTES) {
    wasByteTruncated = true;
    const bytes = Buffer.from(kept, 'utf-8');
    const newline = bytes.lastIndexOf(0x0a, MAX_INDEX_BYTES);
    if (newline > 0) {
      kept = bytes.subarray(0, newline).toString('utf-8');
      keptLineCount = kept.split('\n').length;
    } else {
      // No newline in range: cut inside line 1, backing up to a character boundary.
      let end = MAX_INDEX_BYTES;
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
      kept = bytes.subarray(0, end).toString('utf-8');
      keptLineCount = 1;
      bytesKeptOfLine1 = end;
    }
  }

  let text = kept;
  if (wasLineTruncated || wasByteTruncated) {
    const detail =
      bytesKeptOfLine1 !== undefined
        ? `everything after the first ${formatCount(bytesKeptOfLine1)} bytes of line 1 was cut off`
        : `${formatCount(lines.length - keptLineCount)} of ${formatCount(lines.length)} lines were cut off, starting at line ${formatCount(keptLineCount + 1)} ("${Array.from(lines[keptLineCount]).slice(0, 80).join('')}")`;
    text =
      `${kept}\n\n> WARNING: MEMORY.md is ${formatCount(lines.length)} lines and ${formatCount(byteCount)} bytes ` +
      `(limits: ${formatCount(maxLines)} lines, ${formatCount(MAX_INDEX_BYTES)} bytes). ` +
      `Only part of it was loaded: ${detail}. ` +
      'Keep each entry to one line and move detail into the memory file.';
  }
  return {
    text,
    totalLines: countNonEmptyLines(trimmed),
    loadedLines: countNonEmptyLines(kept),
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/**
 * The memory a session runs with: none when memory is off, and none when the workspace's
 * repository ships files in the memory tree under Book's home ({@link isShippedMemoryTree}), so the
 * session is given no memory directory there to read or to write without asking.
 */
export function sessionMemoryContext(
  workspace: string,
  enabled: boolean,
  opts?: MemoryStoreOptions,
): LoadedMemoryContext | undefined {
  if (!enabled || isShippedMemoryTree(workspace, opts)) return undefined;
  return loadMemoryContext(workspace, opts);
}

export function loadMemoryContext(
  workspace: string,
  opts?: MemoryStoreOptions,
): LoadedMemoryContext {
  const shipped = isShippedMemoryTree(workspace, opts);
  // Before anything is read: a directory keyed the old way moves to the git-root key first,
  // and then the files in it are brought to the current layout.
  if (!shipped) migrateLegacyMemoryDir(workspace, opts);
  const dir = getProjectMemoryDir(workspace, opts);
  if (!shipped) migrateLegacyMemoryFormat(dir);
  const maxIndexLines = opts?.maxIndexLines ?? DEFAULT_MAX_INDEX_LINES;
  const result: LoadedMemoryContext = {
    dir,
    indexFile: null,
    indexLoaded: false,
    indexLineCount: 0,
    loadedLineCount: 0,
    indexByteCount: 0,
    wasLineTruncated: false,
    wasByteTruncated: false,
    indexText: '',
    files: [],
  };

  if (shipped || !existsSync(dir)) return result;

  const indexFile = join(dir, INDEX_FILE);
  if (existsSync(indexFile)) {
    try {
      const st = statSync(indexFile);
      if (st.isFile()) {
        const index = cutIndex(readFileSync(indexFile, 'utf-8'), maxIndexLines);
        result.indexFile = indexFile;
        result.indexLoaded = index.text.length > 0;
        result.indexLineCount = index.totalLines;
        result.loadedLineCount = index.loadedLines;
        result.indexByteCount = index.byteCount;
        result.wasLineTruncated = index.wasLineTruncated;
        result.wasByteTruncated = index.wasByteTruncated;
        result.indexText = index.text;
      }
    } catch {
      result.indexFile = indexFile;
    }
  }

  result.files = listMemoryFiles(workspace, opts);
  return result;
}

export interface MemoryHealth {
  /** Memory files (every `*.md` but MEMORY.md), legacy superseded ones included. */
  fileCount: number;
  /** Files that still carry the retired `status: superseded` frontmatter. */
  legacySupersededCount: number;
  indexLineCount: number;
  /** UTF-8 size of the trimmed MEMORY.md. */
  indexByteCount: number;
  /** The index is over the line limit, so a session loads only part of it. */
  wasLineTruncated: boolean;
  /** The index is over the byte limit, so a session loads only part of it. */
  wasByteTruncated: boolean;
  lastWrite: Date | null;
}

export function getNewestMemoryWriteTime(memoryDir: string): Date | null {
  if (!existsSync(memoryDir)) return null;
  let newestMs = 0;
  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    try {
      const st = lstatSync(join(memoryDir, entry));
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
    } catch {
      // ignore unreadable entries
    }
  }
  return newestMs > 0 ? new Date(newestMs) : null;
}

export function getMemoryHealth(
  workspaceOrContext: string | LoadedMemoryContext,
  opts?: MemoryStoreOptions,
): MemoryHealth {
  const dir =
    typeof workspaceOrContext === 'string'
      ? getProjectMemoryDir(workspaceOrContext, opts)
      : workspaceOrContext.dir;

  let fileCount = 0;
  let legacySupersededCount = 0;
  if (existsSync(dir)) {
    try {
      for (const entry of readdirSync(dir)) {
        // Same rule as listMemoryFiles, so Health agrees with the listing.
        if (entry.startsWith('.') || !isMemoryTopicFile(entry)) continue;
        const full = join(dir, entry);
        try {
          const st = lstatSync(full);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          const summary = summarizeMemoryFile(full, entry);
          if (!summary) continue;
          fileCount++;
          if (summary.legacySuperseded) legacySupersededCount++;
        } catch {
          // ignore unreadable file
        }
      }
    } catch {
      // ignore unreadable directory
    }
  }

  let indexLineCount = 0;
  let indexByteCount = 0;
  let wasLineTruncated = false;
  let wasByteTruncated = false;
  try {
    indexLineCount = readIndexLines(dir).length;
    const indexPath = join(dir, INDEX_FILE);
    if (existsSync(indexPath)) {
      const cut = cutIndex(
        readFileSync(indexPath, 'utf-8'),
        opts?.maxIndexLines ?? DEFAULT_MAX_INDEX_LINES,
      );
      indexByteCount = cut.byteCount;
      wasLineTruncated = cut.wasLineTruncated;
      wasByteTruncated = cut.wasByteTruncated;
    }
  } catch {
    // unreadable index
  }

  return {
    fileCount,
    legacySupersededCount,
    indexLineCount,
    indexByteCount,
    wasLineTruncated,
    wasByteTruncated,
    lastWrite: getNewestMemoryWriteTime(dir),
  };
}

/** The file an index entry links to; undefined for the header or any free-form line. */
function indexEntryFile(line: string): string | undefined {
  return /^- \[[^\]]*\]\(([^()]+)\)/.exec(line)?.[1];
}

/** The index's non-empty lines; throws when it exists but cannot be read, so a caller never
 * rewrites (and wipes) an index it could not read. */
function readIndexLines(dir: string): string[] {
  const indexPath = join(dir, INDEX_FILE);
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** Atomic: a crash mid-write must not leave a truncated index that silently loads nothing. */
function writeIndexLines(dir: string, lines: string[]): void {
  writeFileAtomic(
    join(dir, INDEX_FILE),
    lines.length > 0 ? lines.join('\n') + '\n' : '# Book memory index\n',
  );
}

/**
 * Drop every MEMORY.md line that links to `filename` (a user's `/memory delete`). The index is the
 * model's own, so every other line stays exactly as it is, and an index with no such line is not
 * rewritten at all.
 */
function removeIndexEntries(dir: string, filename: string): void {
  const indexPath = join(dir, INDEX_FILE);
  if (!lstatIfPresent(indexPath)?.isFile()) return;
  const raw = readFileSync(indexPath, 'utf-8');
  const target = filename.toLowerCase();
  const lines = raw.split('\n');
  const kept = lines.filter((line) => {
    const file = indexEntryFile(line);
    return file === undefined || file.replace(/^\.\//, '').toLowerCase() !== target;
  });
  if (kept.length !== lines.length) writeFileAtomic(indexPath, kept.join('\n'));
}

export function deleteMemoryEntry(
  workspace: string,
  slug: string,
  opts?: MemoryStoreOptions,
): { ok: boolean; path?: string; error?: string } {
  try {
    const dir = getProjectMemoryDir(workspace, opts);
    const named = memoryFileForSlug(dir, slug);
    if ('error' in named) return { ok: false, error: named.error };
    const { filename, target } = named;
    if (!lstatIfPresent(target)) {
      return { ok: false, error: `Memory file not found: ${filename}` };
    }
    if (lstatSync(target).isSymbolicLink()) {
      return { ok: false, error: 'Refusing to delete symlinked file.' };
    }

    unlinkSync(target);
    try {
      removeIndexEntries(dir, filename);
    } catch {
      // The file is gone either way; a stale index line points at nothing.
    }
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
