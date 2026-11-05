import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { reachesUncPath } from './unc-path.js';

/**
 * What a git repository tracks, read from its files: the `.git` pointer, `commondir`, `config` and
 * the index. Synchronous, and git is never spawned, so no program the repository configures runs
 * and a synchronous caller (settings resolution) can ask. Every read is bounded and opens without
 * blocking, because the files of a checkout unpacked from an archive are the archive's. Nothing
 * that is, or reaches through a link, a UNC location on Windows is opened, so no read sends a
 * request to a host a checkout named (#579): such a path throws instead.
 */

/** Throws for a path that is, or reaches through a link, a UNC location. */
function refuseUnc(path: string): void {
  if (reachesUncPath(path)) throw new Error(`${path} is on a network share`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * The open descriptor of `path` when it is a regular file; `undefined` when it is absent or is
 * not one. Opened without blocking, so a FIFO, even one swapped in late, never stalls the read.
 */
function openRegularFile(path: string): number | undefined {
  refuseUnc(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw e;
  }
  let regular: boolean;
  try {
    regular = fstatSync(fd).isFile();
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  if (regular) return fd;
  closeSync(fd);
  return undefined;
}

/**
 * `path` as UTF-8, or `undefined` when it is absent or no regular file. Reads at most one byte past
 * `limit`, and throws `tooLarge` when it got that far: a procfs file reports size 0 and never ends.
 */
function readBoundedText(
  path: string,
  limit: number,
  tooLarge = `${path} is larger than ${limit} bytes`,
): string | undefined {
  const fd = openRegularFile(path);
  if (fd === undefined) return undefined;
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > limit) throw new Error(tooLarge);
    return buffer.toString('utf-8', 0, length);
  } finally {
    closeSync(fd);
  }
}

/** Git's pointer files (`.git`, `commondir`, `gitdir`) hold one path; a bigger file is none. */
const MAX_POINTER_FILE_BYTES = 64 * 1024;

/**
 * The first line of the git pointer file `path`, trimmed; undefined when it is absent or no
 * regular file. Throws on one it cannot read or that is too big.
 */
export function readGitPointerFile(path: string): string | undefined {
  const text = readBoundedText(path, MAX_POINTER_FILE_BYTES, `not a git pointer file: ${path}`);
  return text?.split(/\r?\n/, 1)[0].trim();
}

/**
 * The git dir of the work tree `root`, whose `.git` entry marks it: that entry when it is a
 * directory, else the directory its `gitdir:` line names (a linked worktree, a submodule, a
 * `--separate-git-dir` checkout). Throws on a `.git` that is neither.
 */
export function gitDirOf(root: string): string {
  const dotGit = join(root, '.git');
  refuseUnc(dotGit);
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = /^gitdir:[ \t]*(\S.*)$/.exec(readGitPointerFile(dotGit) ?? '');
  if (!pointer) throw new Error(`unrecognized .git file: ${dotGit}`);
  // A relative gitdir resolves against the directory holding the `.git` file.
  return resolve(root, pointer[1]);
}

/** The common dir of `gitDir`: the main repository's for a linked worktree, else `gitDir`. */
export function commonDirOf(gitDir: string): string {
  const common = readGitPointerFile(join(gitDir, 'commondir'));
  return common ? resolve(gitDir, common) : gitDir;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Bytes in one object name in the repository whose common dir is `commonDir`: 32 when its config
 * sets `extensions.objectFormat = sha256`, else 20 (SHA-1). Throws on a config it cannot read.
 */
export function objectNameBytes(commonDir: string): number {
  const config = readBoundedText(join(commonDir, 'config'), MAX_CONFIG_BYTES) ?? '';
  return /^[ \t]*objectformat[ \t]*=[ \t]*"?sha256"?[ \t]*(?:[#;].*)?$/im.test(config) ? 32 : 20;
}

/** One index entry. */
export interface GitIndexEntry {
  /**
   * The path as the index stores it, `/`-separated, decoded one character per byte (latin1), so
   * that string order is the index's own byte order. A sparse index's directory entry ends in `/`.
   */
  path: string;
  /** The file mode: 0o100644 or 0o100755 a file, 0o120000 a link, 0o160000 a submodule, 0o040000 a sparse directory. */
  mode: number;
}

/** An index bigger than this is not read. */
const MAX_INDEX_FILE_BYTES = 512 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const INDEX_SIGNATURE = 0x44495243; // "DIRC"
const EXTENDED_FLAG = 0x4000;
const NAME_LENGTH_MASK = 0x0fff;
/** ctime, mtime, dev, ino, mode, uid, gid and size: ten 32-bit fields before the object name. */
const STAT_BYTES = 40;
const MODE_OFFSET = 24;

/**
 * Reads a file from its start in chunks, so a caller that stops early reads only what it needed.
 * Every offset handed to it is from the start of the file.
 */
class ChunkedFile {
  private buffer = Buffer.alloc(0);
  private filled = 0;
  private ended = false;

  constructor(
    private readonly fd: number,
    private readonly path: string,
  ) {}

  /** Makes bytes `[0, end)` available; throws when the file ends first or would exceed the limit. */
  need(end: number): Buffer {
    if (end <= this.filled) return this.buffer;
    if (end > MAX_INDEX_FILE_BYTES) {
      throw new Error(`${this.path} is larger than ${MAX_INDEX_FILE_BYTES} bytes`);
    }
    if (end > this.buffer.length) {
      const size = Math.min(
        MAX_INDEX_FILE_BYTES,
        Math.max(end, this.buffer.length * 2, READ_CHUNK_BYTES),
      );
      const grown = Buffer.alloc(size);
      this.buffer.copy(grown, 0, 0, this.filled);
      this.buffer = grown;
    }
    while (this.filled < end) {
      if (this.ended) throw new Error(`${this.path} ends inside an entry`);
      const n = readSync(
        this.fd,
        this.buffer,
        this.filled,
        this.buffer.length - this.filled,
        this.filled,
      );
      if (n === 0) this.ended = true;
      else this.filled += n;
    }
    return this.buffer;
  }

  /** The offset of the first NUL at or after `from`, reading on as far as it takes. */
  nulFrom(from: number): number {
    let searched = from;
    while (true) {
      const view = this.need(Math.max(searched, from + 1)).subarray(0, this.filled);
      const found = view.indexOf(0, searched);
      if (found !== -1) return found;
      searched = this.filled;
      this.need(this.filled + 1);
    }
  }
}

/** Git's offset varint (`varint.c`): seven bits a byte, high bit set on all but the last, plus one per continuation. */
function readVarint(file: ChunkedFile, at: number): { value: number; next: number } {
  let offset = at;
  let byte = file.need(offset + 1)[offset++];
  let value = byte & 0x7f;
  while (byte & 0x80) {
    value += 1;
    if (value > 0xffffff) throw new Error('index path prefix length out of range');
    byte = file.need(offset + 1)[offset++];
    value = value * 128 + (byte & 0x7f);
  }
  return { value, next: offset };
}

/** What a split index says about its shared index: which one, and which of its entries are gone. */
interface SplitIndexLink {
  /** The shared index's object name in hex; undefined when it names none (all zeros). */
  sharedIndex: string | undefined;
  /** Positions in the shared index of entries this index deleted. */
  deleted: ReadonlySet<number>;
}

const BITS_IN_EWAH_WORD = 64;

/**
 * The set bits of the EWAH bitmap at `at` (git's `ewah/`): a bit count, a word count, that many
 * 64-bit words, and the position of the last run word. Each run word holds a running bit, how many
 * whole words of it to repeat, and how many literal words follow; a literal word's lowest bit
 * comes first. Throws on a bitmap that does not fit `limit` or that claims more bits than it holds.
 */
function readEwahBitmap(data: Buffer, at: number, limit: number): Set<number> {
  if (at + 8 > limit) throw new Error('split index bitmap is cut short');
  const bitCount = data.readUInt32BE(at);
  const wordCount = data.readUInt32BE(at + 4);
  const wordsAt = at + 8;
  if (wordsAt + wordCount * 8 + 4 > limit) throw new Error('split index bitmap is cut short');
  const positions = new Set<number>();
  const set = (position: number): void => {
    if (position < bitCount) positions.add(position);
  };
  let position = 0;
  let word = 0;
  while (word < wordCount) {
    const high = data.readUInt32BE(wordsAt + word * 8);
    const low = data.readUInt32BE(wordsAt + word * 8 + 4);
    word += 1;
    const runBits = (((low >>> 1) | ((high & 1) << 31)) >>> 0) * BITS_IN_EWAH_WORD;
    const literalWords = high >>> 1;
    if (position + runBits > bitCount + BITS_IN_EWAH_WORD || word + literalWords > wordCount) {
      throw new Error('split index bitmap claims more than it holds');
    }
    if (low & 1) for (let bit = 0; bit < runBits; bit++) set(position + bit);
    position += runBits;
    for (let literal = 0; literal < literalWords; literal++) {
      const literalHigh = data.readUInt32BE(wordsAt + word * 8);
      const literalLow = data.readUInt32BE(wordsAt + word * 8 + 4);
      word += 1;
      for (let bit = 0; bit < 32; bit++) {
        if ((literalLow >>> bit) & 1) set(position + bit);
        if ((literalHigh >>> bit) & 1) set(position + 32 + bit);
      }
      position += BITS_IN_EWAH_WORD;
    }
  }
  return positions;
}

/** The `link` extension among the extensions from `at` to the checksum; undefined when none is. */
function readSplitIndexLink(
  file: ChunkedFile,
  at: number,
  end: number,
  nameBytes: number,
): SplitIndexLink | undefined {
  let offset = at;
  while (offset + 8 <= end) {
    const header = file.need(offset + 8);
    const signature = header.toString('latin1', offset, offset + 4);
    const length = header.readUInt32BE(offset + 4);
    const dataAt = offset + 8;
    if (dataAt + length > end) throw new Error('index extension runs past its file');
    if (signature === 'link') {
      if (length < nameBytes) throw new Error('split index link is cut short');
      const data = file.need(dataAt + length);
      const name = data.toString('hex', dataAt, dataAt + nameBytes);
      return {
        sharedIndex: /^0+$/.test(name) ? undefined : name,
        // A link with no bitmaps deleted nothing; the replace bitmap that follows is about entry
        // contents, and a replaced entry keeps its path.
        deleted:
          length === nameBytes
            ? new Set()
            : readEwahBitmap(data, dataAt + nameBytes, dataAt + length),
      };
    }
    offset = dataAt + length;
  }
  return undefined;
}

/**
 * Walks the entries of the index file at `indexPath`, in its own order (by path, then stage),
 * until `visit` returns true. `undefined` when there is no such file. With `wantLink`, an index
 * walked to its end also reads its split-index link.
 *
 * Reads index versions 2, 3 and 4 (`feature.manyFiles` writes 4). `nameBytes` is the repository's
 * object name length ({@link objectNameBytes}). Throws on anything it does not fully understand:
 * another signature or version, an entry cut short, a name whose recorded length disagrees with it.
 */
function scanIndexFile(
  indexPath: string,
  nameBytes: number,
  visit: (path: string, mode: number, position: number) => boolean,
  wantLink: boolean,
): { link?: SplitIndexLink } | undefined {
  const fd = openRegularFile(indexPath);
  if (fd === undefined) return undefined;
  try {
    const file = new ChunkedFile(fd, indexPath);
    const header = file.need(12);
    if (header.readUInt32BE(0) !== INDEX_SIGNATURE) throw new Error(`${indexPath} is no git index`);
    const version = header.readUInt32BE(4);
    if (version < 2 || version > 4) {
      throw new Error(`${indexPath} is git index version ${version}`);
    }
    const count = header.readUInt32BE(8);
    let offset = 12;
    let previous = '';
    for (let index = 0; index < count; index++) {
      const start = offset;
      const fixed = file.need(start + STAT_BYTES + nameBytes + 2);
      const mode = fixed.readUInt32BE(start + MODE_OFFSET);
      const flags = fixed.readUInt16BE(start + STAT_BYTES + nameBytes);
      let nameAt = start + STAT_BYTES + nameBytes + 2;
      if (flags & EXTENDED_FLAG) {
        if (version < 3) throw new Error(`${indexPath} has an extended entry in version 2`);
        file.need(nameAt + 2);
        nameAt += 2;
      }
      const recordedLength = flags & NAME_LENGTH_MASK;
      let path: string;
      if (version === 4) {
        const { value: strip, next } = readVarint(file, nameAt);
        if (strip > previous.length) throw new Error(`${indexPath} strips past its previous path`);
        const nul = file.nulFrom(next);
        path =
          previous.slice(0, previous.length - strip) + file.need(nul).toString('latin1', next, nul);
        offset = nul + 1;
      } else {
        const nul = file.nulFrom(nameAt);
        path = file.need(nul).toString('latin1', nameAt, nul);
        // The entry is padded with one to eight NULs to a multiple of eight bytes.
        const end = start + ((nameAt - start + (nul - nameAt) + 8) & ~7);
        const padding = file.need(end);
        for (let at = nul; at < end; at++) {
          if (padding[at] !== 0) throw new Error(`${indexPath} has an entry with bad padding`);
        }
        offset = end;
      }
      if (recordedLength < NAME_LENGTH_MASK && path.length !== recordedLength) {
        throw new Error(`${indexPath} has an entry of the wrong length`);
      }
      previous = path;
      if (visit(path, mode, index)) return {};
    }
    if (!wantLink) return {};
    return { link: readSplitIndexLink(file, offset, fstatSync(fd).size - nameBytes, nameBytes) };
  } finally {
    closeSync(fd);
  }
}

/**
 * The entries of the one index file at `indexPath`, stopping before the first entry `past` returns
 * true for: entries are sorted, so a caller after one region of the tree reads no further than it.
 * `undefined` when there is no index file. A split index's own file lists only what changed since
 * its shared index, with an empty path for a shared entry it replaced; {@link visitGitIndex} reads
 * a repository's whole index.
 */
export function readGitIndex(
  indexPath: string,
  nameBytes: number,
  past: (path: string) => boolean = () => false,
): GitIndexEntry[] | undefined {
  const entries: GitIndexEntry[] = [];
  const scanned = scanIndexFile(
    indexPath,
    nameBytes,
    (path, mode) => {
      if (path.length > 0 && past(path)) return true;
      entries.push({ path, mode });
      return false;
    },
    false,
  );
  return scanned && entries;
}

/** Whether `directory` holds any shared index file. Absent directories hold none. */
function holdsSharedIndex(directory: string): boolean {
  try {
    return readdirSync(directory).some((name) => name.startsWith('sharedindex.'));
  } catch (e) {
    const code = errorCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * Walks every path the index of `gitDir` lists until `visit` returns true, as git sees it: in a
 * split index, what the index file itself lists plus what the one shared index its `link` names
 * still holds after the link's delete bitmap, so a path git no longer tracks is not visited. Each
 * file is in order, but the two are not merged. `past` says that nothing further in one sorted
 * file can matter, which a split index's own file cannot use: its `link` is after its entries.
 * A repository with no index visits nothing. Throws as {@link scanIndexFile} does, and when the
 * shared index named is missing.
 */
export function visitGitIndex(
  gitDir: string,
  visit: (path: string, mode: number) => boolean,
  past: (path: string) => boolean = () => false,
): void {
  refuseUnc(gitDir);
  const commonDir = commonDirOf(gitDir);
  const nameBytes = objectNameBytes(commonDir);
  // A leftover shared index only costs reading to the end of the index file. Without one there
  // can be no split index to read, and the sorted read stops early.
  const mayBeSplit = holdsSharedIndex(gitDir) || holdsSharedIndex(commonDir);
  let found = false;
  const own = scanIndexFile(
    join(gitDir, 'index'),
    nameBytes,
    (path, mode) => {
      if (path.length === 0) return false;
      if (!mayBeSplit && past(path)) return true;
      found = visit(path, mode);
      return found;
    },
    mayBeSplit,
  );
  const sharedIndex = own?.link?.sharedIndex;
  if (found || !own?.link || sharedIndex === undefined) return;
  const { deleted } = own.link;
  const fileName = `sharedindex.${sharedIndex}`;
  const scanShared = (directory: string) =>
    scanIndexFile(
      join(directory, fileName),
      nameBytes,
      (path, mode, position) => {
        if (past(path)) return true;
        return !deleted.has(position) && visit(path, mode);
      },
      false,
    );
  if (scanShared(gitDir) === undefined && scanShared(commonDir) === undefined) {
    throw new Error(`${join(gitDir, 'index')} names a shared index that is missing`);
  }
}
