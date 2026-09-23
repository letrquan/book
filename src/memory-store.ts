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
import { permissionRuleMatchesCall } from './permissions.js';
import { resolveBookHome } from './book-home.js';
import { looksLikeSecretOrUnfit } from './secret-detect.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = 'approved' | 'pending' | 'discarded';
export type MemoryOrigin = 'model-tool' | 'extraction' | 'user-text';

export const MAX_BODY_CHARS = 1600;

export function sanitizeMemorySlug(rawSlug: string): string | null {
  const cleaned = rawSlug
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '')
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
}

export interface MemoryWriteInput extends Partial<MemoryCandidate> {
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
  status: MemoryStatus;
  quarantined?: boolean;
  error?: string;
}

const DEFAULT_MAX_INDEX_LINES = 200;
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
  return value === 'approved' || value === 'pending' || value === 'discarded';
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
      if (summary) files.push(summary);
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

  let indexLineCount = 0;
  const indexPath = join(dir, INDEX_FILE);
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, 'utf-8');
      indexLineCount = raw.split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      // ignore
    }
  }

  const lastWrite = getNewestMemoryWriteTime(dir);
  return {
    approvedCount,
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
    const targetSlug = rawTargetSlug?.trim()
      ? (sanitizeMemorySlug(lastSlugSegment(rawTargetSlug.trim())) ?? undefined)
      : undefined;
    const status = isMemoryStatus(frontmatter.status) ? frontmatter.status : undefined;
    const created = typeof frontmatter.created === 'string' ? frontmatter.created : undefined;
    const updated = typeof frontmatter.updated === 'string' ? frontmatter.updated : undefined;
    return {
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

function updateMemoryIndex(
  dir: string,
  title: string,
  filename: string,
  type: MemoryType,
  now: Date,
): string {
  const indexPath = join(dir, INDEX_FILE);
  const entry = `- [${title}](${filename}) — ${type} — ${now.toISOString().slice(0, 10)}`;
  let lines: string[] = [];
  if (existsSync(indexPath)) {
    try {
      lines = readFileSync(indexPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
    } catch {
      lines = [];
    }
  }
  lines = lines.filter((line) => !line.includes(`](${filename})`));
  if (lines.length === 0) {
    lines = ['# Book memory index', '', entry];
  } else if (lines[0].startsWith('#')) {
    lines = [lines[0], entry, ...lines.slice(1).filter((line) => line.trim() !== '')];
  } else {
    lines = [entry, ...lines];
  }
  writeFileSync(indexPath, lines.join('\n') + '\n', 'utf-8');
  return entry;
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
    const candidateInput: MemoryWriteInput = {
      ...candidate,
      title,
      targetSlug,
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
    const memoryInput: MemoryWriteInput = {
      ...candidate,
      title,
      created: existingCreated ?? candidate.created,
    };
    writeFileSync(target, renderMemoryMarkdown(memoryInput, 'approved', now), 'utf-8');
    const indexLine = updateMemoryIndex(dir, title, filename, candidate.type, now);
    return { ok: true, path: target, indexLine, status: 'approved' };
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

    // Remove from MEMORY.md
    const indexPath = join(dir, INDEX_FILE);
    if (existsSync(indexPath)) {
      try {
        const raw = readFileSync(indexPath, 'utf-8');
        const lines = raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .filter((line) => !line.includes(`](${filename})`));
        writeFileSync(
          indexPath,
          lines.length > 0 ? lines.join('\n') + '\n' : '# Book memory index\n',
          'utf-8',
        );
      } catch {
        // ignore
      }
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

    const memoryInput: MemoryWriteInput = {
      ...candidate,
      created: existingCreated ?? candidate.created,
    };
    const rendered = renderMemoryMarkdown(memoryInput, 'approved', now);
    // Move the candidate to discarded BEFORE writing the approved file and
    // updating the index, so a rename failure cannot leave an orphan approved
    // memory + index entry behind on disk. If the rename throws, nothing has
    // been committed yet and the caller can safely retry.
    renameSync(candidatePath, join(getDiscardedDir(workspace, opts), basename(candidatePath)));
    writeFileSync(target, rendered, 'utf-8');
    updateMemoryIndex(dir, candidate.title, filename, candidate.type, now);
    return { ok: true, path: target };
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
