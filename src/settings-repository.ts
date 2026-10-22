import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import type { core } from 'zod';
import { resolveBookHome } from './book-home.js';
import { deleteNestedValue, setNestedValue } from './cli/utils.js';
import { bookSettingsSchema } from './settings.js';
import { redactSettingValue } from './settings-redaction.js';

export type SettingsDocumentReadResult =
  | { status: 'absent'; path: string }
  | { status: 'valid'; path: string; document: Record<string, unknown> }
  | { status: 'malformed'; path: string; error: string }
  | { status: 'non-object'; path: string; error: string };

export interface SettingsDiagnostic {
  path: string;
  issuePath?: string;
  message: string;
}

export type SettingsMutationResult =
  | {
      ok: true;
      path: string;
      document: Record<string, unknown>;
      values: Record<string, unknown>;
      changed: boolean;
    }
  | { ok: false; path: string; diagnostics: SettingsDiagnostic[] };

export interface SettingsRepositoryOptions {
  writeAtomic?: (path: string, contents: string) => void;
}

export const SETTINGS_TOP_LEVEL_KEYS = Object.freeze(Object.keys(bookSettingsSchema.shape).sort());

export function formatSettingsKeyHelp(heading = 'Supported top-level settings:'): string {
  return `${heading}\n${SETTINGS_TOP_LEVEL_KEYS.map((key) => `  ${key}`).join('\n')}`;
}

function issueDiagnostic(path: string, issue: core.$ZodIssue): SettingsDiagnostic {
  return {
    path,
    issuePath: issue.path.join('.'),
    message: issue.message,
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readSettingsDocument(path: string): SettingsDocumentReadResult {
  if (!existsSync(path)) return { status: 'absent', path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    return { status: 'malformed', path, error: safeMessage(error) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'non-object', path, error: 'Settings must contain a JSON object.' };
  }

  return { status: 'valid', path, document: parsed as Record<string, unknown> };
}

/**
 * Why Book will not write the workspace file at `path`, or undefined when it may: the one check
 * every write of a project-layer file Book manages goes through (`.book/settings.json`,
 * `.book/settings.local.json`, `.book/migrations.json`, a project `.mcp.json`), including the read
 * a write starts from.
 *
 * Such a file is written only while it is a regular file or does not exist yet, in a `.book`
 * folder that is a real directory or does not exist yet. Anything else (a link, a FIFO, a device,
 * a directory in the file's place) is left exactly as it is: not read for the write, not written
 * through, and not replaced. The answer is the reason, without the path or a full stop, for the
 * caller's one-line notice: `<path>: <reason>`.
 *
 * The user-global files (`<BOOK_HOME>/settings.json` and `<BOOK_HOME>/mcp.json`) keep their
 * behaviour: they are the user's own, and one kept elsewhere and linked into place is a setup this
 * must not break. Only those two paths are exempt, not the rest of `<BOOK_HOME>`, which also holds
 * checkouts of other repositories.
 */
export function projectFileWriteRefusal(path: string): string | undefined {
  const target = resolve(path);
  const home = resolve(resolveBookHome());
  if (target === join(home, 'settings.json') || target === join(home, 'mcp.json')) {
    return undefined;
  }
  try {
    const folder = dirname(target);
    if (basename(folder) === '.book') {
      const folderStats = lstatSync(folder, { throwIfNoEntry: false });
      if (folderStats && !folderStats.isDirectory()) {
        return 'its .book folder is not a regular directory, so Book left it unchanged';
      }
    }
    const stats = lstatSync(target, { throwIfNoEntry: false });
    if (!stats || stats.isFile()) return undefined;
  } catch (error) {
    return `could not be inspected (${safeMessage(error)}), so Book left it unchanged`;
  }
  return 'not a regular file, so Book left it unchanged';
}

export function writeFileAtomic(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeSync(descriptor, contents, undefined, 'utf-8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function validateTopLevelKeys(
  path: string,
  document: Record<string, unknown>,
): SettingsDiagnostic[] {
  const supported = new Set(SETTINGS_TOP_LEVEL_KEYS);
  return Object.keys(document)
    .filter((key) => !supported.has(key))
    .map((key) => ({
      path,
      issuePath: key,
      message: `Unknown top-level setting. Supported keys: ${SETTINGS_TOP_LEVEL_KEYS.join(', ')}`,
    }));
}

export class SettingsRepository {
  private readonly writeAtomic: (path: string, contents: string) => void;

  constructor(
    readonly path: string,
    options: SettingsRepositoryOptions = {},
  ) {
    this.writeAtomic = options.writeAtomic ?? writeFileAtomic;
  }

  read(): SettingsDocumentReadResult {
    return readSettingsDocument(this.path);
  }

  set(values: Record<string, unknown>): SettingsMutationResult {
    return this.mutate((candidate) => {
      for (const [key, value] of Object.entries(values)) setNestedValue(candidate, key, value);
    }, values);
  }

  remove(paths: string[]): SettingsMutationResult {
    return this.mutate((candidate) => {
      for (const path of paths) deleteNestedValue(candidate, path.split('.'));
    }, {});
  }

  update(
    mutation: (candidate: Record<string, unknown>) => void,
    displayValues: Record<string, unknown> = {},
  ): SettingsMutationResult {
    return this.mutate(mutation, displayValues);
  }

  private mutate(
    mutation: (candidate: Record<string, unknown>) => void,
    values: Record<string, unknown>,
  ): SettingsMutationResult {
    const refusal = projectFileWriteRefusal(this.path);
    if (refusal) {
      return { ok: false, path: this.path, diagnostics: [{ path: this.path, message: refusal }] };
    }
    let lock: number | undefined;
    try {
      lock = this.acquireLock();
      return this.mutateLocked(mutation, values);
    } catch (error) {
      return {
        ok: false,
        path: this.path,
        diagnostics: [{ path: this.path, message: safeMessage(error) }],
      };
    } finally {
      if (lock !== undefined) this.releaseLock(lock);
    }
  }

  private acquireLock(): number {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        return openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
        } catch {
          // Another process may have released or replaced the lock.
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    throw new Error(`Timed out waiting for settings lock: ${lockPath}`);
  }

  private releaseLock(descriptor: number): void {
    closeSync(descriptor);
    try {
      unlinkSync(`${this.path}.lock`);
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }

  private mutateLocked(
    mutation: (candidate: Record<string, unknown>) => void,
    values: Record<string, unknown>,
  ): SettingsMutationResult {
    const source = this.read();
    if (source.status === 'malformed' || source.status === 'non-object') {
      return {
        ok: false,
        path: this.path,
        diagnostics: [{ path: this.path, message: source.error }],
      };
    }

    const candidate = structuredClone(source.status === 'valid' ? source.document : {});
    try {
      mutation(candidate);
    } catch (error) {
      return {
        ok: false,
        path: this.path,
        diagnostics: [{ path: this.path, message: safeMessage(error) }],
      };
    }

    const keyDiagnostics = validateTopLevelKeys(this.path, candidate);
    const validation = bookSettingsSchema.safeParse(candidate);
    const diagnostics = [
      ...keyDiagnostics,
      ...(validation.success
        ? []
        : validation.error.issues.map((issue) => issueDiagnostic(this.path, issue))),
    ];
    if (diagnostics.length > 0) return { ok: false, path: this.path, diagnostics };

    try {
      const changed =
        source.status !== 'valid' || JSON.stringify(source.document) !== JSON.stringify(candidate);
      if (changed) this.writeAtomic(this.path, JSON.stringify(candidate, null, 2) + '\n');
      return {
        ok: true,
        path: this.path,
        document: candidate,
        changed,
        values: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, redactSettingValue(key, value)]),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        path: this.path,
        diagnostics: [{ path: this.path, message: safeMessage(error) }],
      };
    }
  }
}

export function formatSettingsDiagnostics(diagnostics: SettingsDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const location = diagnostic.issuePath
        ? `${diagnostic.path} (${diagnostic.issuePath})`
        : diagnostic.path;
      return `${location}: ${diagnostic.message}`;
    })
    .join('\n');
}
