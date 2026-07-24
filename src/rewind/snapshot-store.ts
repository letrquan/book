import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import ignore from 'ignore';
import type {
  RewindRestoreResult,
  RewindSnapshotCaptureResult,
  RewindSnapshotEntry,
  RewindSnapshotManifest,
  RewindSnapshotStoreInterface,
} from '../types/sessions.js';

export const REWIND_MAX_ENTRIES = 20_000;
export const REWIND_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const REWIND_MAX_LOGICAL_BYTES = 256 * 1024 * 1024;

export interface RewindSnapshotLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxLogicalBytes: number;
}

const DEFAULT_IGNORE_PATTERNS = [
  '.book/',
  'node_modules/',
  '.pnpm-store/',
  '.npm/',
  '.yarn/',
  '.venv/',
  'venv/',
  'env/',
  'dist/',
  'build/',
  'target/',
  '.next/',
  '.cache/',
  '.turbo/',
  '.parcel-cache/',
  '.gradle/',
  'coverage/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '*.pyc',
];

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeWorkspace(workspace: string): string {
  const normalized = resolve(workspace);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function rewindWorkspaceHash(workspace: string): string {
  return sha256(normalizeWorkspace(workspace));
}

export function persistentRewindRoot(workspace: string): string {
  return join(homedir(), '.book', 'rewind', rewindWorkspaceHash(workspace));
}

class UnavailableRewindSnapshotStore implements RewindSnapshotStoreInterface {
  constructor(private readonly reason: string) {}

  capture(): RewindSnapshotCaptureResult {
    return { ok: false, reason: this.reason };
  }

  async captureAsync(): Promise<RewindSnapshotCaptureResult> {
    return this.capture();
  }

  getCurrentGitHead(): string | undefined {
    return undefined;
  }

  getManifest(): RewindSnapshotManifest | undefined {
    return undefined;
  }

  getAvailability() {
    return { available: false, reason: this.reason };
  }

  restore(): RewindRestoreResult {
    return { ok: false, error: this.reason };
  }

  rollback(): { ok: false; error: string } {
    return { ok: false, error: this.reason };
  }

  discardManifest(): void {}

  cleanup() {
    return { manifests: 0, blobs: 0 };
  }
}

export function createUnavailableRewindSnapshotStore(reason: string): RewindSnapshotStoreInterface {
  return new UnavailableRewindSnapshotStore(reason);
}

export function createRewindSnapshotStore(
  workspace: string,
  root?: string,
): RewindSnapshotStoreInterface {
  try {
    return new RewindSnapshotStore(workspace, root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createUnavailableRewindSnapshotStore(
      `Code rewind unavailable: snapshot storage could not be initialized (${detail}).`,
    );
  }
}

function readCustomIgnorePatterns(workspace: string): string[] {
  const path = join(workspace, '.book', 'rewindignore');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function readCustomIgnorePatternsAsync(workspace: string): Promise<string[]> {
  const path = join(workspace, '.book', 'rewindignore');
  try {
    return (await readFile(path, 'utf-8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function expandNegatedParents(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!') && !pattern.slice(1).startsWith('*')) {
      const parts = pattern.slice(1).split('/').filter(Boolean);
      for (let index = 1; index < parts.length; index++) {
        expanded.push(`!${parts.slice(0, index).join('/')}/`);
      }
    }
    expanded.push(pattern);
  }
  return expanded;
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function resolveGitDirectory(workspace: string): string | undefined {
  const dotGit = join(workspace, '.git');
  try {
    if (lstatSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return undefined;
  }

  const match = /^gitdir:\s*(.+)$/i.exec(readOptionalText(dotGit) ?? '');
  return match ? resolve(dirname(dotGit), match[1]) : undefined;
}

function resolveCommonGitDirectory(gitDirectory: string): string {
  const commonDirectory = readOptionalText(join(gitDirectory, 'commondir'));
  return commonDirectory ? resolve(gitDirectory, commonDirectory) : gitDirectory;
}

function parseGitHash(value: string | undefined): string | undefined {
  const hash = value?.trim();
  return hash && /^[0-9a-f]{40,64}$/i.test(hash) ? hash : undefined;
}

function readPackedRef(directory: string, ref: string): string | undefined {
  const packedRefs = readOptionalText(join(directory, 'packed-refs'));
  if (!packedRefs) return undefined;
  for (const line of packedRefs.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const separator = line.indexOf(' ');
    if (separator > 0 && line.slice(separator + 1) === ref) {
      return parseGitHash(line.slice(0, separator));
    }
  }
  return undefined;
}

function resolveGitRef(
  gitDirectory: string,
  commonDirectory: string,
  ref: string,
  depth = 0,
): string | undefined {
  if (
    depth > 4 ||
    !ref.startsWith('refs/') ||
    ref.includes('..') ||
    ref.includes('\\') ||
    ref.includes('\0')
  ) {
    return undefined;
  }

  for (const directory of new Set([gitDirectory, commonDirectory])) {
    const value = readOptionalText(join(directory, ...ref.split('/')));
    const hash = parseGitHash(value);
    if (hash) return hash;
    if (value?.startsWith('ref:')) {
      const resolved = resolveGitRef(
        gitDirectory,
        commonDirectory,
        value.slice('ref:'.length).trim(),
        depth + 1,
      );
      if (resolved) return resolved;
    }
  }

  return (
    readPackedRef(gitDirectory, ref) ??
    (commonDirectory === gitDirectory ? undefined : readPackedRef(commonDirectory, ref))
  );
}

function gitHead(workspace: string): string | undefined {
  const gitDirectory = resolveGitDirectory(workspace);
  if (!gitDirectory) return undefined;
  const head = readOptionalText(join(gitDirectory, 'HEAD'));
  const directHash = parseGitHash(head);
  if (directHash) return directHash;
  if (!head?.startsWith('ref:')) return undefined;
  return resolveGitRef(
    gitDirectory,
    resolveCommonGitDirectory(gitDirectory),
    head.slice('ref:'.length).trim(),
  );
}

async function gitHeadAsync(workspace: string): Promise<string | undefined> {
  return gitHead(workspace);
}

function assertSafeRelativePath(path: string): void {
  if (!path || path.includes('\0') || isAbsolute(path) || path.includes('\\')) {
    throw new Error(`Unsafe rewind path: ${JSON.stringify(path)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe rewind path: ${JSON.stringify(path)}`);
  }
  if (segments.includes('.git')) throw new Error('Rewind snapshots may not contain .git paths.');
}

function resolveEntryPath(workspace: string, path: string): string {
  assertSafeRelativePath(path);
  const target = resolve(workspace, ...path.split('/'));
  const rel = relative(workspace, target);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`Rewind path escapes the workspace: ${path}`);
  }
  return target;
}

type WalkedEntry = {
  path: string;
  absolutePath: string;
  kind: RewindSnapshotEntry['kind'];
  byteSize: number;
  mode: number;
  mtimeMs: number;
};

interface CachedSnapshotEntry {
  kind: RewindSnapshotEntry['kind'];
  byteSize: number;
  mode: number;
  mtimeMs: number;
  snapshotEntry: RewindSnapshotEntry;
}

function walkIncludedEntries(
  workspace: string,
  patterns: string[],
  maxEntries = Number.POSITIVE_INFINITY,
): WalkedEntry[] {
  const matcher = ignore().add(patterns);
  const hasNegations = patterns.some((pattern) => pattern.startsWith('!'));
  const entries: WalkedEntry[] = [];

  const visit = (directory: string, prefix: string) => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      if (child.name === '.git') continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        if (!matcher.ignores(`${path}/`) || hasNegations) visit(absolutePath, path);
        continue;
      }
      if (matcher.ignores(path)) continue;
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      entries.push({
        path,
        absolutePath,
        kind: stat.isSymbolicLink() ? 'symlink' : 'file',
        byteSize: stat.isSymbolicLink() ? Buffer.byteLength(readlinkSync(absolutePath)) : stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      });
      if (entries.length > maxEntries) {
        throw new Error(`Code rewind unavailable: checkpoint exceeds ${maxEntries} entries.`);
      }
    }
  };

  visit(workspace, '');
  return entries;
}

async function walkIncludedEntriesAsync(
  workspace: string,
  patterns: string[],
  maxEntries = Number.POSITIVE_INFINITY,
): Promise<WalkedEntry[]> {
  const matcher = ignore().add(patterns);
  const hasNegations = patterns.some((pattern) => pattern.startsWith('!'));
  const entries: WalkedEntry[] = [];

  const visit = async (directory: string, prefix: string): Promise<void> => {
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    const files: Array<{ child: (typeof children)[number]; path: string; absolutePath: string }> =
      [];
    for (const child of children) {
      if (child.name === '.git') continue;
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        if (!matcher.ignores(`${path}/`) || hasNegations) await visit(absolutePath, path);
        continue;
      }
      if (matcher.ignores(path)) continue;
      files.push({ child, path, absolutePath });
    }
    const stats = await Promise.all(files.map(({ absolutePath }) => lstat(absolutePath)));
    for (let index = 0; index < files.length; index++) {
      const { path, absolutePath } = files[index];
      const stat = stats[index];
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      entries.push({
        path,
        absolutePath,
        kind: stat.isSymbolicLink() ? 'symlink' : 'file',
        byteSize: stat.isSymbolicLink()
          ? Buffer.byteLength(await readlink(absolutePath, { encoding: 'utf-8' }))
          : stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
      });
      if (entries.length > maxEntries) {
        throw new Error(`Code rewind unavailable: checkpoint exceeds ${maxEntries} entries.`);
      }
    }
  };

  await visit(workspace, '');
  return entries;
}

function writeAtomic(path: string, contents: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.book-rewind-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents);
    renameSync(temporary, path);
  } finally {
    if (pathExists(temporary)) unlinkSync(temporary);
  }
}

async function writeAtomicAsync(path: string, contents: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.book-rewind-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pathExistsAsync(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export class RewindSnapshotStore implements RewindSnapshotStoreInterface {
  private readonly manifestsRoot: string;
  private readonly entrySetsRoot: string;
  private readonly blobsRoot: string;
  private readonly workspace: string;
  private readonly limits: RewindSnapshotLimits;
  private fileCache = new Map<string, CachedSnapshotEntry>();

  constructor(
    workspace: string,
    private readonly root = persistentRewindRoot(workspace),
    limits: Partial<RewindSnapshotLimits> = {},
  ) {
    this.workspace = resolve(workspace);
    this.limits = {
      maxEntries: limits.maxEntries ?? REWIND_MAX_ENTRIES,
      maxFileBytes: limits.maxFileBytes ?? REWIND_MAX_FILE_BYTES,
      maxLogicalBytes: limits.maxLogicalBytes ?? REWIND_MAX_LOGICAL_BYTES,
    };
    this.manifestsRoot = join(root, 'manifests');
    this.entrySetsRoot = join(root, 'entry-sets');
    this.blobsRoot = join(root, 'blobs');
    mkdirSync(this.manifestsRoot, { recursive: true });
    mkdirSync(this.entrySetsRoot, { recursive: true });
    mkdirSync(this.blobsRoot, { recursive: true });
  }

  capture(ignorePatterns?: string[]): RewindSnapshotCaptureResult {
    const head = gitHead(this.workspace);
    const patterns =
      ignorePatterns ??
      expandNegatedParents([
        ...DEFAULT_IGNORE_PATTERNS,
        ...readCustomIgnorePatterns(this.workspace),
      ]);
    try {
      const walked = walkIncludedEntries(this.workspace, patterns, this.limits.maxEntries);

      let logicalBytes = 0;
      const entries: RewindSnapshotEntry[] = [];
      const nextCache = new Map<string, CachedSnapshotEntry>();
      for (const entry of walked) {
        if (entry.byteSize > this.limits.maxFileBytes) {
          throw new Error(
            `Code rewind unavailable: ${entry.path} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`,
          );
        }
        const cached = this.fileCache.get(entry.path);
        if (
          cached &&
          cached.kind === entry.kind &&
          cached.byteSize === entry.byteSize &&
          cached.mode === entry.mode &&
          cached.mtimeMs === entry.mtimeMs
        ) {
          logicalBytes += cached.snapshotEntry.byteSize;
          if (logicalBytes > this.limits.maxLogicalBytes) {
            throw new Error(
              `Code rewind unavailable: checkpoint exceeds ${this.limits.maxLogicalBytes} bytes of file content.`,
            );
          }
          entries.push(cached.snapshotEntry);
          nextCache.set(entry.path, cached);
          continue;
        }
        const contents =
          entry.kind === 'symlink'
            ? Buffer.from(readlinkSync(entry.absolutePath), 'utf-8')
            : readFileSync(entry.absolutePath);
        if (contents.byteLength > this.limits.maxFileBytes) {
          throw new Error(
            `Code rewind unavailable: ${entry.path} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`,
          );
        }
        logicalBytes += contents.byteLength;
        if (logicalBytes > this.limits.maxLogicalBytes) {
          throw new Error(
            `Code rewind unavailable: checkpoint exceeds ${this.limits.maxLogicalBytes} bytes of file content.`,
          );
        }
        const blobHash = sha256(contents);
        const blobPath = join(this.blobsRoot, blobHash);
        if (!existsSync(blobPath)) writeAtomic(blobPath, contents);
        const snapshotEntry: RewindSnapshotEntry = {
          path: entry.path.replaceAll('\\', '/'),
          kind: entry.kind,
          blobHash,
          byteSize: contents.byteLength,
          mode: entry.mode,
        };
        entries.push(snapshotEntry);
        nextCache.set(entry.path, {
          kind: entry.kind,
          byteSize: entry.byteSize,
          mode: entry.mode,
          mtimeMs: entry.mtimeMs,
          snapshotEntry,
        });
      }

      const manifest: RewindSnapshotManifest = {
        version: 1,
        id: randomUUID(),
        workspace: normalizeWorkspace(this.workspace),
        createdAt: Date.now(),
        gitHead: head,
        ignorePatterns: patterns,
        entries,
        logicalBytes,
      };
      this.writeManifest(manifest);
      this.fileCache = nextCache;
      return { ok: true, manifest };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        gitHead: head,
      };
    }
  }

  async captureAsync(ignorePatterns?: string[]): Promise<RewindSnapshotCaptureResult> {
    let head: string | undefined;
    try {
      const [resolvedHead, customIgnorePatterns] = await Promise.all([
        gitHeadAsync(this.workspace),
        ignorePatterns ? Promise.resolve([]) : readCustomIgnorePatternsAsync(this.workspace),
      ]);
      head = resolvedHead;
      const patterns =
        ignorePatterns ??
        expandNegatedParents([...DEFAULT_IGNORE_PATTERNS, ...customIgnorePatterns]);
      const walked = await walkIncludedEntriesAsync(
        this.workspace,
        patterns,
        this.limits.maxEntries,
      );

      let logicalBytes = 0;
      const entries: RewindSnapshotEntry[] = [];
      const nextCache = new Map<string, CachedSnapshotEntry>();
      for (const entry of walked) {
        if (entry.byteSize > this.limits.maxFileBytes) {
          throw new Error(
            `Code rewind unavailable: ${entry.path} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`,
          );
        }
        const cached = this.fileCache.get(entry.path);
        if (
          cached &&
          cached.kind === entry.kind &&
          cached.byteSize === entry.byteSize &&
          cached.mode === entry.mode &&
          cached.mtimeMs === entry.mtimeMs
        ) {
          logicalBytes += cached.snapshotEntry.byteSize;
          if (logicalBytes > this.limits.maxLogicalBytes) {
            throw new Error(
              `Code rewind unavailable: checkpoint exceeds ${this.limits.maxLogicalBytes} bytes of file content.`,
            );
          }
          entries.push(cached.snapshotEntry);
          nextCache.set(entry.path, cached);
          continue;
        }
        const contents =
          entry.kind === 'symlink'
            ? Buffer.from(await readlink(entry.absolutePath, { encoding: 'utf-8' }), 'utf-8')
            : await readFile(entry.absolutePath);
        if (contents.byteLength > this.limits.maxFileBytes) {
          throw new Error(
            `Code rewind unavailable: ${entry.path} exceeds the ${this.limits.maxFileBytes}-byte per-file limit.`,
          );
        }
        logicalBytes += contents.byteLength;
        if (logicalBytes > this.limits.maxLogicalBytes) {
          throw new Error(
            `Code rewind unavailable: checkpoint exceeds ${this.limits.maxLogicalBytes} bytes of file content.`,
          );
        }
        const blobHash = sha256(contents);
        const blobPath = join(this.blobsRoot, blobHash);
        if (!(await pathExistsAsync(blobPath))) await writeAtomicAsync(blobPath, contents);
        const snapshotEntry: RewindSnapshotEntry = {
          path: entry.path.replaceAll('\\', '/'),
          kind: entry.kind,
          blobHash,
          byteSize: contents.byteLength,
          mode: entry.mode,
        };
        entries.push(snapshotEntry);
        nextCache.set(entry.path, {
          kind: entry.kind,
          byteSize: entry.byteSize,
          mode: entry.mode,
          mtimeMs: entry.mtimeMs,
          snapshotEntry,
        });
      }

      const manifest: RewindSnapshotManifest = {
        version: 1,
        id: randomUUID(),
        workspace: normalizeWorkspace(this.workspace),
        createdAt: Date.now(),
        gitHead: head,
        ignorePatterns: patterns,
        entries,
        logicalBytes,
      };
      await this.writeManifestAsync(manifest);
      this.fileCache = nextCache;
      return { ok: true, manifest };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        gitHead: head,
      };
    }
  }

  getManifest(id: string): RewindSnapshotManifest | undefined {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined;
    const path = join(this.manifestsRoot, `${id}.json`);
    if (!existsSync(path)) return undefined;
    try {
      const stored = JSON.parse(readFileSync(path, 'utf-8')) as RewindSnapshotManifest & {
        entrySetHash?: string;
      };
      let manifest: RewindSnapshotManifest = stored;
      if (!Array.isArray(stored.entries) && stored.entrySetHash) {
        if (!/^[a-f0-9]{64}$/.test(stored.entrySetHash)) return undefined;
        const entriesPath = join(this.entrySetsRoot, `${stored.entrySetHash}.json`);
        if (!existsSync(entriesPath)) return undefined;
        const serializedEntries = readFileSync(entriesPath, 'utf-8');
        if (sha256(serializedEntries) !== stored.entrySetHash) return undefined;
        manifest = {
          ...stored,
          entries: JSON.parse(serializedEntries) as RewindSnapshotEntry[],
        };
      }
      if (
        manifest.version !== 1 ||
        manifest.id !== id ||
        normalizeWorkspace(manifest.workspace) !== normalizeWorkspace(this.workspace) ||
        !Array.isArray(manifest.entries)
      ) {
        return undefined;
      }
      return manifest;
    } catch {
      return undefined;
    }
  }

  getCurrentGitHead(): string | undefined {
    return gitHead(this.workspace);
  }

  getAvailability(id: string | undefined, expectedGitHead?: string) {
    if (!id) return { available: false, reason: 'No filesystem checkpoint was captured.' };
    if (!this.getManifest(id)) {
      return { available: false, reason: 'The filesystem checkpoint is missing or corrupt.' };
    }
    if (this.getCurrentGitHead() !== expectedGitHead) {
      return {
        available: false,
        reason: 'Git HEAD changed since this prompt; rewind never moves HEAD or the index.',
      };
    }
    return { available: true };
  }

  restore(id: string): RewindRestoreResult {
    const manifest = this.getManifest(id);
    if (!manifest) return { ok: false, error: 'The filesystem checkpoint is missing or corrupt.' };
    const availability = this.getAvailability(id, manifest.gitHead);
    if (!availability.available) return { ok: false, error: availability.reason ?? 'Unavailable.' };

    const safety = this.capture(manifest.ignorePatterns);
    if (!safety.ok) {
      return { ok: false, error: `Could not create a safety snapshot: ${safety.reason}` };
    }
    if (this.getCurrentGitHead() !== manifest.gitHead) {
      this.discardManifest(safety.manifest.id);
      return {
        ok: false,
        error: 'Git HEAD changed while preparing rewind; no files were restored.',
      };
    }

    try {
      this.applyManifest(manifest);
      return { ok: true, safetySnapshotId: safety.manifest.id };
    } catch (error) {
      const rollback = this.applyManifestSafely(safety.manifest);
      this.discardManifest(safety.manifest.id);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(rollback.ok ? {} : { rollbackError: rollback.error }),
      };
    }
  }

  rollback(safetySnapshotId: string): { ok: true } | { ok: false; error: string } {
    const manifest = this.getManifest(safetySnapshotId);
    if (!manifest) return { ok: false, error: 'The safety snapshot is missing or corrupt.' };
    const result = this.applyManifestSafely(manifest);
    if (result.ok) this.discardManifest(safetySnapshotId);
    return result;
  }

  discardManifest(id: string): void {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return;
    const path = join(this.manifestsRoot, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  private writeManifest(manifest: RewindSnapshotManifest): void {
    const entriesHash = sha256(JSON.stringify(manifest.entries));
    const entriesPath = join(this.entrySetsRoot, `${entriesHash}.json`);
    if (!existsSync(entriesPath)) writeAtomic(entriesPath, JSON.stringify(manifest.entries));
    const metadata = { ...manifest } as Partial<RewindSnapshotManifest> & {
      entrySetHash?: string;
    };
    delete metadata.entries;
    writeAtomic(
      join(this.manifestsRoot, `${manifest.id}.json`),
      JSON.stringify({ ...metadata, entrySetHash: entriesHash }),
    );
  }

  private async writeManifestAsync(manifest: RewindSnapshotManifest): Promise<void> {
    const entriesHash = sha256(JSON.stringify(manifest.entries));
    const entriesPath = join(this.entrySetsRoot, `${entriesHash}.json`);
    if (!(await pathExistsAsync(entriesPath))) {
      await writeAtomicAsync(entriesPath, JSON.stringify(manifest.entries));
    }
    const metadata = { ...manifest } as Partial<RewindSnapshotManifest> & {
      entrySetHash?: string;
    };
    delete metadata.entries;
    await writeAtomicAsync(
      join(this.manifestsRoot, `${manifest.id}.json`),
      JSON.stringify({ ...metadata, entrySetHash: entriesHash }),
    );
  }

  cleanup(referencedSnapshotIds: Set<string>, days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    let manifests = 0;
    let blobs = 0;
    for (const file of readdirSync(this.manifestsRoot)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const manifest = this.getManifest(id);
      if (referencedSnapshotIds.has(id)) continue;
      if (!manifest || manifest.createdAt < cutoff) {
        unlinkSync(join(this.manifestsRoot, file));
        manifests++;
      }
    }

    const referencedBlobs = new Set<string>();
    const referencedEntrySets = new Set<string>();
    for (const file of readdirSync(this.manifestsRoot)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const manifest = this.getManifest(id);
      try {
        const stored = JSON.parse(readFileSync(join(this.manifestsRoot, file), 'utf-8')) as {
          entrySetHash?: string;
        };
        if (stored.entrySetHash) referencedEntrySets.add(stored.entrySetHash);
      } catch {
        // Corrupt manifests are removed or ignored above.
      }
      for (const entry of manifest?.entries ?? []) referencedBlobs.add(entry.blobHash);
    }
    for (const file of readdirSync(this.entrySetsRoot)) {
      if (!file.endsWith('.json') || referencedEntrySets.has(file.slice(0, -5))) continue;
      rmSync(join(this.entrySetsRoot, file), { force: true });
    }
    for (const file of readdirSync(this.blobsRoot)) {
      if (referencedBlobs.has(file)) continue;
      rmSync(join(this.blobsRoot, file), { force: true });
      blobs++;
    }
    return { manifests, blobs };
  }

  private applyManifestSafely(
    manifest: RewindSnapshotManifest,
  ): { ok: true } | { ok: false; error: string } {
    try {
      this.applyManifest(manifest);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private applyManifest(manifest: RewindSnapshotManifest): void {
    if (manifest.entries.length > this.limits.maxEntries) {
      throw new Error(`Rewind manifest exceeds ${this.limits.maxEntries} entries.`);
    }
    const targetPaths = new Set<string>();
    let logicalBytes = 0;
    for (const entry of manifest.entries) {
      resolveEntryPath(this.workspace, entry.path);
      if (!['file', 'symlink'].includes(entry.kind) || !Number.isInteger(entry.mode)) {
        throw new Error(`Invalid rewind entry for ${entry.path}.`);
      }
      if (targetPaths.has(entry.path)) throw new Error(`Duplicate rewind path: ${entry.path}.`);
      if (!/^[a-f0-9]{64}$/.test(entry.blobHash)) {
        throw new Error(`Invalid blob hash for ${entry.path}.`);
      }
      const blobPath = join(this.blobsRoot, entry.blobHash);
      if (!existsSync(blobPath)) throw new Error(`Missing rewind blob for ${entry.path}.`);
      const contents = readFileSync(blobPath);
      if (sha256(contents) !== entry.blobHash)
        throw new Error(`Corrupt rewind blob for ${entry.path}.`);
      if (
        contents.byteLength !== entry.byteSize ||
        contents.byteLength > this.limits.maxFileBytes
      ) {
        throw new Error(`Invalid rewind size for ${entry.path}.`);
      }
      logicalBytes += contents.byteLength;
      if (logicalBytes > this.limits.maxLogicalBytes) {
        throw new Error(`Rewind manifest exceeds ${this.limits.maxLogicalBytes} bytes.`);
      }
      targetPaths.add(entry.path);
    }

    const current = walkIncludedEntries(
      this.workspace,
      manifest.ignorePatterns,
      this.limits.maxEntries,
    );
    const removals = current
      .filter((entry) => !targetPaths.has(entry.path))
      .sort((a, b) => b.path.length - a.path.length);
    for (const entry of removals) unlinkSync(entry.absolutePath);

    for (const entry of manifest.entries) {
      const target = resolveEntryPath(this.workspace, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      if (pathExists(target) && lstatSync(target).isDirectory()) {
        throw new Error(`Cannot restore ${entry.path} because a directory exists at that path.`);
      }
      const contents = readFileSync(join(this.blobsRoot, entry.blobHash));
      const temporary = join(dirname(target), `.book-rewind-${randomUUID()}.tmp`);
      try {
        if (entry.kind === 'symlink') {
          symlinkSync(contents.toString('utf-8'), temporary);
        } else {
          writeFileSync(temporary, contents, { mode: entry.mode });
          chmodSync(temporary, entry.mode);
        }
        renameSync(temporary, target);
      } finally {
        if (pathExists(temporary)) unlinkSync(temporary);
      }
    }
  }
}
