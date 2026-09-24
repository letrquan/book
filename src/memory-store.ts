import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { basename, isAbsolute, join, relative, resolve } from 'path';
import { parseFrontmatter } from './frontmatter.js';
import { writeFileAtomic } from './settings-repository.js';
import { permissionRuleMatchesCall } from './permissions.js';
import { resolveBookHome } from './book-home.js';
import { looksLikeSecretOrUnfit } from './secret-detect.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = 'approved' | 'pending' | 'discarded' | 'superseded';
export type MemoryOrigin = 'model-tool' | 'extraction' | 'user-text';

export const MAX_BODY_CHARS = 1600;

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
 * an absolute path) names its file instead of being pasted onto `dir`. This is the
 * only place a slug is sanitized: every caller passes raw model or user input and
 * gets back a resolved filename, or the reason it cannot be used.
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

/** Whether a permission rule list names MemorySave (a bare `MemorySave` or a pattern on it). */
export function rulesNameMemorySave(rules: readonly string[]): boolean {
  return rules.some((rule) =>
    permissionRuleMatchesCall(rule, { id: 'memory', name: 'MemorySave', arguments: {} }),
  );
}

export function isMemorySaveAvailable(settings?: {
  memory?: { enabled?: boolean; autoSave?: boolean };
}): boolean {
  if (!settings?.memory) return true;
  return settings.memory.enabled !== false && settings.memory.autoSave !== false;
}

export function sanitizeMemoryTitle(rawTitle: string): string {
  return rawTitle
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/[[\]()]/g, '')
    .replace(/^[\s#]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
}

export function shouldRejectMemoryText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > MAX_BODY_CHARS * 2) return 'too long';
  return looksLikeSecretOrUnfit(trimmed);
}

export interface MemoryFileSummary {
  name: string;
  path: string;
  type?: MemoryType;
  status?: MemoryStatus;
  title?: string;
  created?: string;
  updated?: string;
  size: number;
}

export interface LoadedMemoryContext {
  dir: string;
  indexFile: string | null;
  indexLoaded: boolean;
  indexLineCount: number;
  loadedLineCount: number;
  indexText: string;
  files: MemoryFileSummary[];
  candidates: MemoryFileSummary[];
}

export interface MemoryCandidate {
  type: MemoryType;
  title: string;
  body: string;
  origin: MemoryOrigin;
  source?: 'auto' | 'manual';
  confidence?: 'low' | 'medium' | 'high';
  tags?: string[];
  sessionId?: string;
  externalContext: boolean;
  evidence?: string[];
  targetSlug?: string;
  /** File name of an approved memory this one replaces; it is kept on disk, out of the index. */
  supersedes?: string;
}

export interface MemoryWriteInput extends Partial<MemoryCandidate> {
  supersededBy?: string;
  type: MemoryType;
  title: string;
  body: string;
  status?: MemoryStatus;
  created?: string;
  targetSlug?: string;
}

export interface MemoryStoreOptions {
  bookRoot?: string;
  now?: Date;
  maxIndexLines?: number;
  dir?: string;
}

export interface MemoryWriteResult {
  ok: boolean;
  path?: string;
  /** Approve only: the memory this approval retired, or why a recorded retirement was skipped. */
  retired?: string;
  retireSkipped?: string;
  error?: string;
}

export interface SaveMemoryOptions extends MemoryStoreOptions {
  requireApproval?: boolean;
  quarantineExternal?: boolean;
  slug?: string;
}

export interface SaveMemoryResult {
  ok: boolean;
  path?: string;
  indexLine?: string;
  /** Lines in MEMORY.md after the write — the model is asked to consolidate near the load limit. */
  indexLineCount?: number;
  /** File name of the memory this save retired (superseded). */
  retired?: string;
  status: MemoryStatus;
  quarantined?: boolean;
  error?: string;
}

export const DEFAULT_MAX_INDEX_LINES = 200;
const INDEX_FILE = 'MEMORY.md';
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

export function getProjectMemoryDir(workspace: string, opts?: MemoryStoreOptions): string {
  return join(bookRoot(opts), 'projects', slugifyWorkspace(workspace), 'memory');
}

export function getMemoryInboxDir(workspace: string, opts?: MemoryStoreOptions): string {
  return opts?.dir
    ? join(opts.dir, INBOX_DIR)
    : join(getProjectMemoryDir(workspace, opts), INBOX_DIR);
}

export function getMemoryExtractionStatePath(workspace: string, opts?: MemoryStoreOptions): string {
  return join(getProjectMemoryDir(workspace, opts), '.extraction-state.json');
}

export function getMemoryExtractionLockPath(workspace: string, opts?: MemoryStoreOptions): string {
  return join(getProjectMemoryDir(workspace, opts), '.extraction.lock');
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return (
    value === 'approved' || value === 'pending' || value === 'discarded' || value === 'superseded'
  );
}

function titleFromBody(body: string): string | undefined {
  const firstHeading = body.split('\n').find((line) => line.startsWith('# '));
  return firstHeading?.replace(/^#\s+/, '').trim();
}

function summarizeMemoryFile(path: string, name = basename(path)): MemoryFileSummary | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const raw = readFileSync(path, 'utf-8');
    const { body, frontmatter } = parseFrontmatter(raw);
    const proposedTitle =
      typeof frontmatter.proposedTitle === 'string' ? frontmatter.proposedTitle : undefined;
    const title =
      proposedTitle ??
      (typeof frontmatter.title === 'string' ? frontmatter.title : undefined) ??
      titleFromBody(body);
    return {
      name,
      path,
      type: isMemoryType(frontmatter.type) ? frontmatter.type : undefined,
      status: isMemoryStatus(frontmatter.status) ? frontmatter.status : undefined,
      title,
      created: typeof frontmatter.created === 'string' ? frontmatter.created : undefined,
      updated: typeof frontmatter.updated === 'string' ? frontmatter.updated : undefined,
      size: st.size,
    };
  } catch {
    return null;
  }
}

export function listMemoryFiles(workspace: string, opts?: MemoryStoreOptions): MemoryFileSummary[] {
  const dir = getProjectMemoryDir(workspace, opts);
  if (!existsSync(dir)) return [];
  const files: MemoryFileSummary[] = [];
  try {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      if (entry.toLowerCase() === INDEX_FILE.toLowerCase()) continue; // MEMORY.md is the index, not an approved memory file.
      const full = join(dir, entry);
      const summary = summarizeMemoryFile(full, entry);
      // A superseded memory stays on disk as history but is no longer an active entry.
      if (summary && summary.status !== 'superseded') files.push(summary);
    }
  } catch {
    return files;
  }
  return files;
}

export function listMemoryCandidates(
  workspace: string,
  opts?: MemoryStoreOptions,
): MemoryFileSummary[] {
  const dir = getMemoryInboxDir(workspace, opts);
  if (!existsSync(dir)) return [];
  const files: MemoryFileSummary[] = [];
  try {
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const full = join(dir, entry);
      const summary = summarizeMemoryFile(full, entry);
      if (summary) files.push(summary);
    }
  } catch {
    return files;
  }
  return files;
}

// Deliberately cheaper than listMemoryCandidates(): readdir only, no frontmatter parse.
export function countMemoryCandidates(workspace: string, opts?: MemoryStoreOptions): number {
  const dir = getMemoryInboxDir(workspace, opts);
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir).filter((entry) => !entry.startsWith('.') && entry.endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

function readFirstLines(
  path: string,
  maxLines: number,
): { text: string; totalLines: number; loadedLines: number } {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n');
  const loaded = lines.slice(0, maxLines);
  return {
    text: loaded.join('\n').trim(),
    totalLines: lines.filter((line) => line.trim().length > 0).length,
    loadedLines: loaded.filter((line) => line.trim().length > 0).length,
  };
}

export function loadMemoryContext(
  workspace: string,
  opts?: MemoryStoreOptions,
): LoadedMemoryContext {
  const dir = getProjectMemoryDir(workspace, opts);
  const maxIndexLines = opts?.maxIndexLines ?? DEFAULT_MAX_INDEX_LINES;
  const result: LoadedMemoryContext = {
    dir,
    indexFile: null,
    indexLoaded: false,
    indexLineCount: 0,
    loadedLineCount: 0,
    indexText: '',
    files: [],
    candidates: [],
  };

  if (!existsSync(dir)) return result;

  const indexFile = join(dir, INDEX_FILE);
  if (existsSync(indexFile)) {
    try {
      const st = statSync(indexFile);
      if (st.isFile()) {
        const index = readFirstLines(indexFile, maxIndexLines);
        result.indexFile = indexFile;
        result.indexLoaded = index.text.length > 0;
        result.indexLineCount = index.totalLines;
        result.loadedLineCount = index.loadedLines;
        result.indexText = index.text;
      }
    } catch {
      result.indexFile = indexFile;
    }
  }

  result.files = listMemoryFiles(workspace, opts);
  result.candidates = listMemoryCandidates(workspace, opts);
  return result;
}

export interface MemoryHealth {
  approvedCount: number;
  supersededCount: number;
  inboxCount: number;
  indexLineCount: number;
  lastWrite: Date | null;
}

export function getNewestMemoryWriteTime(memoryDir: string): Date | null {
  if (!existsSync(memoryDir)) return null;
  let newestMs = 0;

  function scanEntries(dir: string, isInbox: boolean): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) {
        if (!isInbox && entry === INBOX_DIR) {
          scanEntries(join(dir, entry), true);
        }
        continue;
      }
      if (isInbox && entry === DISCARDED_DIR) {
        continue;
      }
      const full = join(dir, entry);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isFile()) {
          if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  scanEntries(memoryDir, false);
  return newestMs > 0 ? new Date(newestMs) : null;
}

export function getMemoryHealth(
  workspaceOrContext: string | LoadedMemoryContext,
  opts?: MemoryStoreOptions,
): MemoryHealth {
  const dir =
    typeof workspaceOrContext === 'string'
      ? (opts?.dir ?? getProjectMemoryDir(workspaceOrContext, opts))
      : workspaceOrContext.dir;
  const workspace = typeof workspaceOrContext === 'string' ? workspaceOrContext : '';

  let approvedCount = 0;
  let supersededCount = 0;
  if (existsSync(dir)) {
    try {
      for (const entry of readdirSync(dir)) {
        // Same rule as listMemoryFiles, so Health agrees with the listing.
        if (
          !entry.toLowerCase().endsWith('.md') ||
          entry.toLowerCase() === INDEX_FILE.toLowerCase()
        )
          continue;
        const full = join(dir, entry);
        try {
          const st = lstatSync(full);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          const summary = summarizeMemoryFile(full, entry);
          if (summary && (summary.status === 'approved' || summary.status === undefined)) {
            approvedCount++;
          } else if (summary?.status === 'superseded') {
            supersededCount++;
          }
        } catch {
          // ignore unreadable file
        }
      }
    } catch {
      // ignore unreadable directory
    }
  }

  const inboxCount = countMemoryCandidates(workspace, { ...opts, dir });

  // Counted the way a save counts it, so Health and the pressure warning agree.
  let indexLineCount = 0;
  try {
    indexLineCount = readIndexLines(dir).length;
  } catch {
    // unreadable index
  }

  const lastWrite = getNewestMemoryWriteTime(dir);
  return {
    approvedCount,
    supersededCount,
    inboxCount,
    indexLineCount,
    lastWrite,
  };
}

function safeTitle(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'memory'
  );
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function formatTags(tags: string[] | undefined): string {
  if (!tags?.length) return '';
  return `tags:\n${tags.map((tag) => `- ${tag}`).join('\n')}\n`;
}

function renderMemoryMarkdown(input: MemoryWriteInput, status: MemoryStatus, now: Date): string {
  const created = input.created ?? now.toISOString();
  const updated = now.toISOString();
  const sanitizedTitle = sanitizeMemoryTitle(input.title);
  const title = status === 'pending' ? `Candidate: ${sanitizedTitle}` : sanitizedTitle;
  const origin: MemoryOrigin = input.origin ?? 'user-text';
  const source = input.source ?? (origin === 'user-text' ? 'manual' : 'auto');
  const externalContext = input.externalContext ?? false;

  // Build frontmatter fields, dropping optional ones that are absent so we
  // don't rely on a blanket ''.filter() that would also strip the blank
  // spacer lines between the closing fence, the heading, and the body.
  const fm: string[] = [
    `type: ${input.type}`,
    `status: ${status}`,
    `origin: ${origin}`,
    `source: ${source}`,
    `externalContext: ${externalContext}`,
    `created: ${created}`,
    `updated: ${updated}`,
  ];
  if (input.sessionId) fm.push(`sessionId: ${input.sessionId}`);
  if (input.evidence?.length) {
    fm.push(`evidence:\n${input.evidence.map((e) => `- ${e}`).join('\n')}`);
  }
  // Already a resolved file name: `memoryFileForSlug` sanitized it (and
  // `readMemoryFile` did the same for a candidate read back from disk).
  if (input.targetSlug) fm.push(`targetSlug: ${input.targetSlug}`);
  if (input.supersedes) fm.push(`supersedes: ${input.supersedes}`);
  if (input.supersededBy) fm.push(`supersededBy: ${input.supersededBy}`);
  if ('confidence' in input && input.confidence) fm.push(`confidence: ${input.confidence}`);
  if (status === 'pending') fm.push(`proposedTitle: ${sanitizedTitle}`);
  if (input.tags?.length) {
    fm.push(formatTags(input.tags).trimEnd());
  }
  return ['---', ...fm, '---', '', `# ${title}`, '', input.body.trim(), ''].join('\n');
}

export function writeMemoryCandidate(
  workspace: string,
  candidate: MemoryWriteInput,
  opts?: MemoryStoreOptions,
): MemoryWriteResult {
  try {
    const title = sanitizeMemoryTitle(candidate.title);
    if (!title) {
      return { ok: false, error: 'title must not be empty after sanitizing.' };
    }
    const now = opts?.now ?? new Date();
    const inbox = getMemoryInboxDir(workspace, opts);
    mkdirSync(inbox, { recursive: true });
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const hash = shortHash(`${candidate.type}\n${title}\n${candidate.body}\n${now.toISOString()}`);
    const filename = `${stamp}-cand-${safeTitle(title)}-${hash}.md`;
    const path = join(inbox, filename);
    writeFileSync(path, renderMemoryMarkdown({ ...candidate, title }, 'pending', now), 'utf-8');
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function resolveCandidatePath(
  workspace: string,
  candidateFile: string,
  opts?: MemoryStoreOptions,
): string | null {
  const inbox = resolve(getMemoryInboxDir(workspace, opts));
  const raw = isAbsolute(candidateFile) ? candidateFile : join(inbox, candidateFile);
  const resolved = resolve(raw);
  const rel = relative(inbox, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

function activeMemoryFilename(
  input: { type: MemoryType; title: string; body: string },
  now: Date,
): string {
  const date = now.toISOString().slice(0, 10);
  const hash = shortHash(`${input.type}\n${input.title}\n${input.body}`);
  return `${date}-${input.type}-${safeTitle(input.title)}-${hash}.md`;
}

/** A slug read back from frontmatter: last path segment, then sanitized (as on write). */
function frontmatterSlug(raw: string | undefined): string | undefined {
  return raw?.trim() ? (sanitizeMemorySlug(lastSlugSegment(raw.trim())) ?? undefined) : undefined;
}

export function readMemoryFile(
  path: string,
): (MemoryCandidate & { created?: string; updated?: string; status?: MemoryStatus }) | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { body, frontmatter } = parseFrontmatter(raw);
    if (!isMemoryType(frontmatter.type)) return null;
    const rawProposed =
      typeof frontmatter.proposedTitle === 'string' ? frontmatter.proposedTitle : undefined;
    const proposedTitle = rawProposed ? sanitizeMemoryTitle(rawProposed) || undefined : undefined;
    // `||`, not `??`: a title that sanitizes to '' falls through to the next source.
    const heading = titleFromBody(body)?.replace(/^Candidate:\s*/i, '');
    const title =
      proposedTitle ||
      (typeof frontmatter.title === 'string' ? sanitizeMemoryTitle(frontmatter.title) : '') ||
      (heading ? sanitizeMemoryTitle(heading) : '') ||
      basename(path, '.md');
    const tags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
      : undefined;
    const evidence = Array.isArray(frontmatter.evidence)
      ? frontmatter.evidence.filter((e): e is string => typeof e === 'string')
      : undefined;
    const cleanBody = body.replace(/^#\s+[^\n]*\n+/i, '').trim() || body.trim();
    const origin: MemoryOrigin =
      frontmatter.origin === 'model-tool' ||
      frontmatter.origin === 'extraction' ||
      frontmatter.origin === 'user-text'
        ? frontmatter.origin
        : 'user-text';
    const source: 'auto' | 'manual' =
      frontmatter.source === 'manual' || frontmatter.source === 'auto'
        ? frontmatter.source
        : origin === 'user-text'
          ? 'manual'
          : 'auto';
    const externalContext =
      frontmatter.externalContext === true || frontmatter.externalContext === 'true';
    const sessionId = typeof frontmatter.sessionId === 'string' ? frontmatter.sessionId : undefined;
    const rawTargetSlug =
      typeof frontmatter.targetSlug === 'string' ? frontmatter.targetSlug : undefined;
    // The last path segment, the same rule `memoryFileForSlug` applies on write:
    // a legacy `targetSlug: notes/build` names a file in the memory directory,
    // and sanitizing alone would glue the segments together.
    const targetSlug = frontmatterSlug(rawTargetSlug);
    const status = isMemoryStatus(frontmatter.status) ? frontmatter.status : undefined;
    const created = typeof frontmatter.created === 'string' ? frontmatter.created : undefined;
    const updated = typeof frontmatter.updated === 'string' ? frontmatter.updated : undefined;
    const supersedes = frontmatterSlug(
      typeof frontmatter.supersedes === 'string' ? frontmatter.supersedes : undefined,
    );
    return {
      supersedes,
      type: frontmatter.type,
      title,
      body: cleanBody,
      origin,
      source,
      externalContext,
      sessionId,
      evidence,
      targetSlug,
      status,
      confidence:
        frontmatter.confidence === 'low' ||
        frontmatter.confidence === 'medium' ||
        frontmatter.confidence === 'high'
          ? frontmatter.confidence
          : undefined,
      tags,
      created,
      updated,
    };
  } catch {
    return null;
  }
}

function parseCandidateFile(path: string): (MemoryCandidate & { created?: string }) | null {
  return readMemoryFile(path);
}

/**
 * Characters index text must not carry: control characters, and `[]()<>` — an entry is parsed
 * by its `](file)` link, and the index is embedded in a <memory-index> block.
 */
const INDEX_UNSAFE = /[\x00-\x1f\x7f-\x9f[\]()<>]/g;

/** The first line of a memory's body — the fact itself — as a short index hook. */
function indexHook(body: string): string {
  const first =
    body.trim().split('\n')[0]?.replace(INDEX_UNSAFE, ' ').replace(/\s+/g, ' ').trim() ?? '';
  return first.length > 100 ? `${first.slice(0, 100)}…` : first;
}

const sameFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
 * The index lines that still describe a loadable memory. Entries whose file is gone or
 * superseded are pruned on every rewrite — so a line a failed write left behind does not load
 * forever — and so are entries for the files in `drop`.
 */
function liveIndexLines(dir: string, lines: string[], drop: readonly string[]): string[] {
  return lines.filter((line) => {
    const file = indexEntryFile(line);
    if (!file) return true;
    if (drop.some((name) => sameFile(name, file))) return false;
    const path = join(dir, file);
    if (!existsSync(path)) return false;
    return summarizeMemoryFile(path, file)?.status !== 'superseded';
  });
}

/** Drop a file's line from MEMORY.md; no index means nothing to drop (and none is created). */
function removeIndexEntry(dir: string, filename: string): void {
  if (!existsSync(join(dir, INDEX_FILE))) return;
  writeIndexLines(dir, liveIndexLines(dir, readIndexLines(dir), [filename]));
}

/**
 * Write or replace a file's line in MEMORY.md in one read-modify-write, also dropping the line
 * of a memory it supersedes; returns the line and the index's entry count.
 */
function updateMemoryIndex(
  dir: string,
  title: string,
  filename: string,
  type: MemoryType,
  now: Date,
  body: string,
  supersedes?: string,
): { entry: string; lineCount: number } {
  const hook = indexHook(body);
  const entry = `- [${title}](${filename}) — ${type} — ${now.toISOString().slice(0, 10)}${hook && hook !== title ? ` — ${hook}` : ''}`;
  const drop = supersedes ? [filename, supersedes] : [filename];
  let lines = liveIndexLines(dir, readIndexLines(dir), drop);
  if (lines.length === 0) {
    lines = ['# Book memory index', entry];
  } else if (lines[0].startsWith('#')) {
    lines = [lines[0], entry, ...lines.slice(1)];
  } else {
    lines = [entry, ...lines];
  }
  writeIndexLines(dir, lines);
  return { entry, lineCount: lines.length };
}

/** Set frontmatter fields in place, leaving every other field, the headings and the body as they are. */
function setFrontmatterFields(raw: string, fields: Record<string, string>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const entries = Object.entries(fields);
  if (!match) {
    return `---\n${entries.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${raw}`;
  }
  let frontmatter = match[1];
  for (const [key, value] of entries) {
    const line = new RegExp(`^${key}:.*$`, 'm');
    frontmatter = line.test(frontmatter)
      ? frontmatter.replace(line, `${key}: ${value}`)
      : `${frontmatter}\n${key}: ${value}`;
  }
  return `---\n${frontmatter}\n---\n${raw.slice(match[0].length)}`;
}

/**
 * Retire a memory another replaced: only its status, `supersededBy` and `updated` change, so the
 * file stays intact as history. Best effort, after the index already dropped its line — if the
 * rewrite fails, the file stays `approved` on disk, and the next index write prunes it anyway.
 */
function markSuperseded(dir: string, oldFilename: string, byFilename: string, now: Date): void {
  try {
    const target = join(dir, oldFilename);
    if (isSymlink(target)) return;
    const raw = readFileSync(target, 'utf-8');
    writeFileAtomic(
      target,
      setFrontmatterFields(raw, {
        status: 'superseded',
        supersededBy: byFilename,
        updated: now.toISOString(),
      }),
    );
  } catch {
    // see above
  }
}

/**
 * Resolve a `supersedes` slug to the on-disk name of an active memory other than `own`. A name
 * that matches no file, or one already superseded, is an error the caller reports — never a
 * silent no-op that leaves two versions loading.
 */
function resolveSupersedes(
  dir: string,
  raw: string | undefined,
  own: string | undefined,
): { filename?: string } | { error: string } {
  if (!raw?.trim()) return {};
  const named = memoryFileForSlug(dir, raw);
  if ('error' in named) return { error: `supersedes: ${named.error}` };
  // The on-disk spelling: a case-insensitive file system finds `Deploy.md` for `deploy.md`,
  // and the index and frontmatter must name the file exactly as it is.
  let actual: string | undefined;
  try {
    actual = readdirSync(dir).find((f) => sameFile(f, named.filename));
  } catch {
    actual = undefined;
  }
  if (!actual || isSymlink(join(dir, actual))) {
    return {
      error: `supersedes: no memory file ${named.filename}. Use the file name from <memory-index>.`,
    };
  }
  if (own && sameFile(actual, own)) return {};
  const current = summarizeMemoryFile(join(dir, actual), actual);
  if (current?.status === 'superseded') {
    return {
      error: `supersedes: ${actual} is already superseded; supersede its replacement instead.`,
    };
  }
  return { filename: actual };
}

/** True for a symlink, dangling or not: `existsSync` follows links, `lstat` does not. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where an approved memory lands — the named slug's file, or a generated name — with the
 * original creation time when it updates an entry. Refuses a symlinked target, including a
 * dangling one, which `writeFileSync` would follow out of the memory directory.
 */
function approvedTarget(
  dir: string,
  input: { type: MemoryType; title: string },
  slug: string | undefined,
  now: Date,
): { filename: string; target: string; existingCreated?: string } | { error: string } {
  const named = slug?.trim() ? memoryFileForSlug(dir, slug) : null;
  if (named && 'error' in named) return { error: named.error };
  const filename = named?.filename ?? activeMemoryFilename(input as MemoryCandidate, now);
  const target = named?.target ?? join(dir, filename);
  if (isSymlink(target)) return { error: 'Refusing to overwrite symlinked memory file.' };
  const existingCreated = named && existsSync(target) ? readMemoryFile(target)?.created : undefined;
  return { filename, target, existingCreated };
}

export function saveMemory(
  workspace: string,
  candidate: MemoryWriteInput,
  opts?: SaveMemoryOptions,
): SaveMemoryResult {
  const quarantineExternal = opts?.quarantineExternal ?? true;
  const isQuarantined = candidate.externalContext === true && quarantineExternal;
  const requireApproval = (opts?.requireApproval ?? false) || isQuarantined;
  const title = sanitizeMemoryTitle(candidate.title);
  if (!title) {
    return {
      ok: false,
      error: 'title must not be empty after sanitizing.',
      status: requireApproval ? 'pending' : 'approved',
      quarantined: isQuarantined,
    };
  }

  if (requireApproval) {
    const rawSlug = opts?.slug?.trim()
      ? opts.slug
      : candidate.targetSlug?.trim()
        ? candidate.targetSlug
        : undefined;
    let targetSlug: string | undefined;
    if (rawSlug) {
      const named = memoryFileForSlug(getProjectMemoryDir(workspace, opts), rawSlug);
      if ('error' in named) {
        return { ok: false, error: named.error, status: 'pending', quarantined: isQuarantined };
      }
      targetSlug = named.filename;
    }
    // Resolved against the entry's own target; re-checked when the candidate is approved.
    const retire = resolveSupersedes(
      getProjectMemoryDir(workspace, opts),
      candidate.supersedes,
      targetSlug,
    );
    if ('error' in retire) {
      return { ok: false, error: retire.error, status: 'pending', quarantined: isQuarantined };
    }
    const candidateInput: MemoryWriteInput = {
      ...candidate,
      title,
      targetSlug,
      supersedes: retire.filename,
    };
    const writeResult = writeMemoryCandidate(workspace, candidateInput, opts);
    if (!writeResult.ok) {
      return { ok: false, error: writeResult.error, status: 'pending', quarantined: isQuarantined };
    }
    return { ok: true, path: writeResult.path, status: 'pending', quarantined: isQuarantined };
  }

  try {
    const now = opts?.now ?? new Date();
    const dir = getProjectMemoryDir(workspace, opts);
    mkdirSync(dir, { recursive: true });

    const placed = approvedTarget(dir, { ...candidate, title }, opts?.slug, now);
    if ('error' in placed) return { ok: false, error: placed.error, status: 'approved' };
    const { filename, target, existingCreated } = placed;
    // Against the real target, generated name included, so a save never retires itself.
    const retire = resolveSupersedes(dir, candidate.supersedes, filename);
    if ('error' in retire) return { ok: false, error: retire.error, status: 'approved' };
    // Fail before writing anything when the index cannot be read, rather than leave a memory
    // on disk that no index line will ever load.
    readIndexLines(dir);
    const memoryInput: MemoryWriteInput = {
      ...candidate,
      title,
      supersedes: retire.filename,
      created: existingCreated ?? candidate.created,
    };
    writeFileSync(target, renderMemoryMarkdown(memoryInput, 'approved', now), 'utf-8');
    const index = updateMemoryIndex(
      dir,
      title,
      filename,
      candidate.type,
      now,
      candidate.body,
      memoryInput.supersedes,
    );
    if (memoryInput.supersedes) markSuperseded(dir, memoryInput.supersedes, filename, now);
    return {
      ok: true,
      path: target,
      indexLine: index.entry,
      indexLineCount: index.lineCount,
      retired: memoryInput.supersedes,
      status: 'approved',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), status: 'approved' };
  }
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
    if (!existsSync(target)) {
      return { ok: false, error: `Memory file not found: ${filename}` };
    }
    if (lstatSync(target).isSymbolicLink()) {
      return { ok: false, error: 'Refusing to delete symlinked file.' };
    }

    unlinkSync(target);
    try {
      removeIndexEntry(dir, filename);
    } catch {
      // The file is gone either way; a stale index line points at nothing and is dropped by the
      // next index write.
    }
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function approveMemoryCandidate(
  workspace: string,
  candidateFile: string,
  opts?: MemoryStoreOptions,
): MemoryWriteResult {
  try {
    const candidatePath = resolveCandidatePath(workspace, candidateFile, opts);
    if (!candidatePath)
      return { ok: false, error: 'Candidate path must stay inside the memory inbox.' };
    if (!existsSync(candidatePath))
      return { ok: false, error: `Candidate not found: ${candidateFile}` };
    if (lstatSync(candidatePath).isSymbolicLink())
      return { ok: false, error: 'Refusing to approve symlinked candidate.' };

    const candidate = parseCandidateFile(candidatePath);
    if (!candidate)
      return { ok: false, error: 'Candidate has invalid or missing memory frontmatter.' };

    const now = opts?.now ?? new Date();
    const dir = getProjectMemoryDir(workspace, opts);
    mkdirSync(dir, { recursive: true });

    if (!candidate.title.trim()) return { ok: false, error: 'Candidate has an empty title.' };
    const placed = approvedTarget(dir, candidate, candidate.targetSlug, now);
    if ('error' in placed) return { ok: false, error: placed.error };
    const { filename, target, existingCreated } = placed;

    // A candidate's `supersedes` was resolved when it was saved; re-check it now, since the
    // target may have gone or be the entry being approved.
    const retire = resolveSupersedes(dir, candidate.supersedes, filename);
    const supersedes = 'error' in retire ? undefined : retire.filename;
    const retireSkipped = 'error' in retire ? retire.error : undefined;
    const memoryInput: MemoryWriteInput = {
      ...candidate,
      supersedes,
      created: existingCreated ?? candidate.created,
    };
    const rendered = renderMemoryMarkdown(memoryInput, 'approved', now);
    // Move the candidate to discarded BEFORE writing the approved file and
    // updating the index, so a rename failure cannot leave an orphan approved
    // memory + index entry behind on disk. If the rename throws, nothing has
    // been committed yet and the caller can safely retry.
    // An unreadable index fails the approval here, while the candidate is still in the inbox.
    readIndexLines(dir);
    renameSync(candidatePath, join(getDiscardedDir(workspace, opts), basename(candidatePath)));
    writeFileSync(target, rendered, 'utf-8');
    updateMemoryIndex(
      dir,
      candidate.title,
      filename,
      candidate.type,
      now,
      candidate.body,
      supersedes,
    );
    if (supersedes) markSuperseded(dir, supersedes, filename, now);
    return { ok: true, path: target, retired: supersedes, retireSkipped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function getDiscardedDir(workspace: string, opts?: MemoryStoreOptions): string {
  const dir = join(getMemoryInboxDir(workspace, opts), DISCARDED_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function discardMemoryCandidate(
  workspace: string,
  candidateFile: string,
  opts?: MemoryStoreOptions,
): MemoryWriteResult {
  try {
    const candidatePath = resolveCandidatePath(workspace, candidateFile, opts);
    if (!candidatePath)
      return { ok: false, error: 'Candidate path must stay inside the memory inbox.' };
    if (!existsSync(candidatePath))
      return { ok: false, error: `Candidate not found: ${candidateFile}` };
    if (lstatSync(candidatePath).isSymbolicLink())
      return { ok: false, error: 'Refusing to discard symlinked candidate.' };
    const discardedPath = join(getDiscardedDir(workspace, opts), basename(candidatePath));
    renameSync(candidatePath, discardedPath);
    return { ok: true, path: discardedPath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
