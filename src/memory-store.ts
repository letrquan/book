import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { parseFrontmatter } from './frontmatter.js';

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryStatus = 'approved' | 'pending' | 'discarded';

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
  source: 'auto' | 'manual';
  confidence?: 'low' | 'medium' | 'high';
  tags?: string[];
}

export interface MemoryWriteInput extends MemoryCandidate {
  status?: MemoryStatus;
}

export interface MemoryStoreOptions {
  bookRoot?: string;
  now?: Date;
  maxIndexLines?: number;
}

export interface MemoryWriteResult {
  ok: boolean;
  path?: string;
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
  return opts?.bookRoot ?? join(homedir(), '.book');
}

export function getProjectMemoryDir(workspace: string, opts?: MemoryStoreOptions): string {
  return join(bookRoot(opts), 'projects', slugifyWorkspace(workspace), 'memory');
}

export function getMemoryInboxDir(workspace: string, opts?: MemoryStoreOptions): string {
  return join(getProjectMemoryDir(workspace, opts), INBOX_DIR);
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
      if (!entry.endsWith('.md')) continue;
      if (entry === INDEX_FILE) continue; // MEMORY.md is the index, not an approved memory file.
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
  const created = now.toISOString();
  const title = status === 'pending' ? `Candidate: ${input.title}` : input.title;
  // Build frontmatter fields, dropping optional ones that are absent so we
  // don't rely on a blanket ''.filter() that would also strip the blank
  // spacer lines between the closing fence, the heading, and the body.
  const fm: string[] = [
    `type: ${input.type}`,
    `status: ${status}`,
    `source: ${input.source}`,
    `created: ${created}`,
    `updated: ${created}`,
  ];
  if ('confidence' in input && input.confidence) fm.push(`confidence: ${input.confidence}`);
  if (status === 'pending') fm.push(`proposedTitle: ${input.title}`);
  if (input.tags?.length) {
    fm.push(formatTags(input.tags).trimEnd());
  }
  return ['---', ...fm, '---', '', `# ${title}`, '', input.body.trim(), ''].join('\n');
}

export function writeMemoryCandidate(
  workspace: string,
  candidate: MemoryCandidate,
  opts?: MemoryStoreOptions,
): MemoryWriteResult {
  try {
    const now = opts?.now ?? new Date();
    const inbox = getMemoryInboxDir(workspace, opts);
    mkdirSync(inbox, { recursive: true });
    const stamp = now.toISOString().replace(/[-:.]/g, '').slice(0, 15);
    const hash = shortHash(
      `${candidate.type}\n${candidate.title}\n${candidate.body}\n${now.toISOString()}`,
    );
    const filename = `${stamp}-cand-${safeTitle(candidate.title)}-${hash}.md`;
    const path = join(inbox, filename);
    writeFileSync(path, renderMemoryMarkdown(candidate, 'pending', now), 'utf-8');
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

function parseCandidateFile(path: string): (MemoryCandidate & { created?: string }) | null {
  const raw = readFileSync(path, 'utf-8');
  const { body, frontmatter } = parseFrontmatter(raw);
  if (!isMemoryType(frontmatter.type)) return null;
  const title =
    typeof frontmatter.proposedTitle === 'string'
      ? frontmatter.proposedTitle
      : (titleFromBody(body)?.replace(/^Candidate:\s*/i, '') ?? basename(path, '.md'));
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((t): t is string => typeof t === 'string')
    : undefined;
  const cleanBody = body.replace(/^#\s+Candidate:\s*.*\n*/i, '').trim() || body.trim();
  return {
    type: frontmatter.type,
    title,
    body: cleanBody,
    source: frontmatter.source === 'manual' ? 'manual' : 'auto',
    confidence:
      frontmatter.confidence === 'low' ||
      frontmatter.confidence === 'medium' ||
      frontmatter.confidence === 'high'
        ? frontmatter.confidence
        : undefined,
    tags,
    created: typeof frontmatter.created === 'string' ? frontmatter.created : undefined,
  };
}

function updateMemoryIndex(
  dir: string,
  title: string,
  filename: string,
  type: MemoryType,
  now: Date,
): void {
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
    const filename = activeMemoryFilename(candidate, now);
    const target = join(dir, filename);
    const rendered = renderMemoryMarkdown(candidate, 'approved', now);
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
