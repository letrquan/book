import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { throwIfAborted } from '../async.js';

export type LineEnding = 'lf' | 'crlf';

export interface TextSnapshot {
  exists: boolean;
  bytes: Buffer;
  text: string;
  bom: boolean;
  lineEnding: LineEnding;
  mixedLineEndings: boolean;
  binary: boolean;
  mode?: number;
}

const pathLocks = new Map<string, Promise<void>>();

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) controls++;
  }
  return sample.length > 0 && controls / sample.length > 0.1;
}

export async function readTextSnapshot(
  filePath: string,
  allowMissing = false,
): Promise<TextSnapshot> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        bytes: Buffer.alloc(0),
        text: '',
        bom: false,
        lineEnding: 'lf',
        mixedLineEndings: false,
        binary: false,
        mode: undefined,
      };
    }
    throw error;
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bytes.subarray(bom ? 3 : 0);
  let binary = looksBinary(bytes);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    binary = true;
    decoded = body.toString('utf8');
  }
  const crlfCount = (decoded.match(/\r\n/g) ?? []).length;
  const bareLfCount = (decoded.replace(/\r\n/g, '').match(/\n/g) ?? []).length;
  const bareCrCount = (decoded.replace(/\r\n/g, '').match(/\r/g) ?? []).length;
  const mixedLineEndings = (crlfCount > 0 && bareLfCount > 0) || bareCrCount > 0;
  const mode = (await stat(filePath)).mode & 0o777;
  return {
    exists: true,
    bytes,
    text: decoded.replace(/\r\n/g, '\n'),
    bom,
    lineEnding: crlfCount > bareLfCount ? 'crlf' : 'lf',
    mixedLineEndings,
    binary,
    mode,
  };
}

export function restoreTextEncoding(
  text: string,
  snapshot: Pick<TextSnapshot, 'bom' | 'lineEnding'>,
): Buffer {
  const body = snapshot.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return Buffer.from(`${snapshot.bom ? '\ufeff' : ''}${body}`, 'utf8');
}

export async function writeFileAtomically(
  filePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  mode?: number,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.book-tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    throwIfAborted(signal);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function removeFileAtomically(filePath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await rm(filePath, { force: false });
}

async function acquirePath(path: string): Promise<() => void> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  pathLocks.set(path, queued);
  await previous;
  return () => {
    release();
    if (pathLocks.get(path) === queued) pathLocks.delete(path);
  };
}

/** Serialize mutation validation and commit for each path, in stable order. */
export async function withMutationLocks<T>(
  paths: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const path of [...new Set(paths)].sort()) releases.push(await acquirePath(path));
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
