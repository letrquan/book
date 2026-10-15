import { lstatSync, readFileSync } from 'fs';
import { relative, resolve, sep } from 'path';
import type { ToolContext, ToolResult } from './types/tools.js';
import { DEFAULT_MAX_INDEX_LINES, MAX_INDEX_BYTES } from './memory-limits.js';
import { looksLikeSecretOrUnfit } from './secret-detect.js';
import { canonicalizePath } from './tools/path-utils.js';
import { toolFailure } from './tools/result.js';

/**
 * The checks and the provenance stamp every mutation tool applies to a write into the memory
 * directory, after it has computed the final content and before it writes.
 *
 * Imports no memory module with a runtime dependency on `permissions.ts` (the file tools reach this
 * file, and `permissions.ts` reaches the file tools), which is why the limits live in
 * `memory-limits.ts`.
 */

/** A topic file past this size still saves, with a warning: one fact per file. */
export const TOPIC_FILE_WARN_BYTES = 4_096;

const INDEX_FILE = 'MEMORY.md';
const DELEGATED_TYPES: readonly string[] = ['project', 'reference'];

export type MemoryWriteCheck =
  { ok: true; content: string | null; warnings: string[] } | { ok: false; failure: ToolResult };

function refuse(code: string, message: string, remediation: string): MemoryWriteCheck {
  return { ok: false, failure: toolFailure(message, { code, remediation }) };
}

// -- frontmatter ------------------------------------------------------------------------------
// Edited line by line rather than parsed and re-serialized, so a stamp changes only the metadata
// block's own lines and leaves every other key, comment and the body byte-for-byte as written.

interface Frontmatter {
  lines: string[];
  /** Index of the closing `---`; line 0 opens the block. */
  close: number;
}

const stripCr = (line: string): string => line.replace(/\r$/, '');

function findFrontmatter(text: string): Frontmatter | null {
  const lines = text.split('\n');
  if (stripCr(lines[0] ?? '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (stripCr(lines[i]) === '---') return { lines, close: i };
  }
  return null;
}

interface MetadataBlock {
  /** Index of the `metadata:` line. */
  start: number;
  /** One past the last child line (blank lines trailing the block do not count). */
  end: number;
  /** Leading whitespace of the children. */
  indent: string;
  /** The mapping is written inline (`metadata: {}`), so there are no child lines to edit. */
  inline: string | null;
}

function metadataBlock({ lines, close }: Frontmatter): MetadataBlock | null {
  const start = lines.findIndex((line, i) => i > 0 && i < close && /^metadata\s*:/.test(line));
  if (start < 0) return null;
  const rest = stripCr(lines[start])
    .replace(/^metadata\s*:/, '')
    .replace(/\s+#.*$/, '')
    .trim();
  let last = start;
  let indent = '  ';
  let sawChild = false;
  for (let i = start + 1; i < close; i++) {
    const line = stripCr(lines[i]);
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    if (!sawChild) {
      indent = /^\s*/.exec(line)?.[0] ?? '  ';
      sawChild = true;
    }
    last = i;
  }
  return {
    start,
    end: last + 1,
    indent,
    inline: rest === '' || rest.startsWith('#') ? null : rest,
  };
}

function scalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, '').trim();
  return value.replace(/^(["'])(.*)\1$/, '$2');
}

/** The line index of `key` among the metadata block's own children, or -1. */
function childKey(lines: string[], block: MetadataBlock, key: string): number {
  for (let i = block.start + 1; i < block.end; i++) {
    const line = stripCr(lines[i]);
    if (!line.startsWith(block.indent)) continue;
    const rest = line.slice(block.indent.length);
    if (/^\s/.test(rest)) continue;
    if (new RegExp(`^${key}\\s*:`).test(rest)) return i;
  }
  return -1;
}

/** A frontmatter value, from `metadata.<key>` first and then the top level (the legacy layout). */
function frontmatterValue(text: string, key: string): string | undefined {
  const fm = findFrontmatter(text);
  if (!fm) return undefined;
  const block = metadataBlock(fm);
  if (block && block.inline === null) {
    const at = childKey(fm.lines, block, key);
    if (at >= 0)
      return scalar(
        stripCr(fm.lines[at])
          .slice(block.indent.length)
          .replace(/^[^:]*:/, ''),
      );
  }
  for (let i = 1; i < fm.close; i++) {
    const line = stripCr(fm.lines[i]);
    if (new RegExp(`^${key}\\s*:`).test(line)) return scalar(line.replace(/^[^:]*:/, ''));
  }
  return undefined;
}

function yamlScalar(value: string): string {
  return /^[\w.:-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Set `metadata.originSessionId` (kept when present), `metadata.modified` and, when asked,
 * `metadata.driver` on a topic file that has frontmatter. Returns the text unchanged, with a
 * warning, when the metadata mapping is written in a form this cannot edit line by line.
 */
function stamp(
  text: string,
  options: { sessionId?: string; driver: boolean },
): { text: string; warning?: string } {
  const fm = findFrontmatter(text);
  if (!fm) return { text };
  const { lines } = fm;
  const cr = lines[0].endsWith('\r') ? '\r' : '';
  let block = metadataBlock(fm);
  if (block && block.inline !== null && block.inline !== '{}') {
    return {
      text,
      warning: 'The metadata block is written inline, so it was not stamped with provenance.',
    };
  }
  if (block && block.inline === '{}') {
    lines[block.start] = `metadata:${cr}`;
    block = { ...block, inline: null };
  }

  const wanted: Array<{
    key: string;
    value: (existing: string | undefined) => string | undefined;
  }> = [
    {
      key: 'originSessionId',
      value: (existing) => (existing ? undefined : options.sessionId),
    },
    { key: 'modified', value: () => new Date().toISOString() },
    ...(options.driver ? [{ key: 'driver', value: () => 'agent' }] : []),
  ];

  if (!block) {
    const indent = '  ';
    const added = wanted.flatMap(({ key, value }) => {
      const next = value(undefined);
      return next === undefined ? [] : [`${indent}${key}: ${yamlScalar(next)}${cr}`];
    });
    lines.splice(fm.close, 0, `metadata:${cr}`, ...added);
    return { text: lines.join('\n') };
  }

  const inserts: string[] = [];
  for (const { key, value } of wanted) {
    const at = childKey(lines, block, key);
    const line = at >= 0 ? stripCr(lines[at]) : '';
    const existing =
      at >= 0 ? scalar(line.slice(block.indent.length).replace(/^[^:]*:/, '')) : undefined;
    const next = value(existing || undefined);
    if (next === undefined) continue;
    if (at < 0) {
      inserts.push(`${block.indent}${key}: ${yamlScalar(next)}${cr}`);
      continue;
    }
    const comment = /(\s+#.*)$/.exec(line.slice(line.indexOf(':') + 1))?.[1] ?? '';
    lines[at] = `${line.slice(0, line.indexOf(':') + 1)} ${yamlScalar(next)}${comment}${cr}`;
  }
  lines.splice(block.end, 0, ...inserts);
  return { text: lines.join('\n') };
}

// -- the index and ownership ------------------------------------------------------------------

/** The file an index entry (`- [Title](file.md) — hook`) links to; undefined for any other line. */
function entryTarget(line: string): string | undefined {
  return /^- \[[^\]]*\]\(([^()]+)\)/.exec(line)?.[1];
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/** A regular (not linked) file inside the memory root, or null when absent or out of bounds. */
function readMemoryFile(root: string, name: string): string | null {
  const path = resolve(root, name);
  const rel = relative(resolve(root), path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

const isAgentOwned = (text: string): boolean => frontmatterValue(text, 'driver') === 'agent';

/** The message a refusal about a person's file gives. */
const OWNED_BY_PERSON =
  'This session is driven by another agent, so it may change only memories it wrote itself ' +
  '(frontmatter `driver: agent`).';

/**
 * Check a write into the memory directory, and stamp the provenance.
 *
 * @param next    The content about to be written, or `null` for a delete.
 * @param prior   The file's current content, or `null` for a new file.
 * @returns The content to write in place of `next`, and warnings for the tool to append to its
 *          result; or the failure to return instead of writing.
 */
export function checkMemoryWrite(
  ctx: ToolContext,
  absPath: string,
  next: string | null,
  prior: string | null,
): MemoryWriteCheck {
  const memory = ctx.memoryWrite;
  if (!memory) {
    return refuse(
      'memory_write_unavailable',
      'Memory is not writable in this session.',
      'Only the main agent may write memory, and only with memory enabled and autoSave on.',
    );
  }
  const root = canonicalizePath(memory.root);
  const rel = relative(root, canonicalizePath(absPath)).split(sep).join('/');
  const isIndex = rel.toLowerCase() === INDEX_FILE.toLowerCase();
  const learnings = memory.scope === 'learnings';

  // 2. Secrets. In the index only what this write adds is judged, so one old line cannot block
  // every later edit of it.
  if (next !== null) {
    let judged = next;
    if (isIndex && prior !== null) {
      const had = new Set(normalizeLines(prior));
      judged = normalizeLines(next)
        .filter((line) => !had.has(line))
        .join('\n');
    }
    const reason = judged.trim() === '' ? null : looksLikeSecretOrUnfit(judged);
    if (reason) {
      return refuse(
        'memory_secret_rejected',
        `Memory text ${reason}, so it was not saved.`,
        'Remove the secret or high-entropy text (keys, tokens, passwords, long random strings) and write the memory again.',
      );
    }
  }

  // 3. A session another agent drives writes only what it learned, and changes only its own.
  if (learnings) {
    if (isIndex) {
      if (prior !== null) {
        const kept = new Set(next === null ? [] : normalizeLines(next));
        for (const line of normalizeLines(prior)) {
          if (kept.has(line)) continue;
          const target = entryTarget(line);
          if (target === undefined) continue;
          const file = readMemoryFile(memory.root, target);
          if (file !== null && !isAgentOwned(file)) {
            return refuse(
              'memory_owned_by_person',
              `The index line for ${target} was changed or removed, but ${target} is not a memory this session wrote. ${OWNED_BY_PERSON}`,
              'Keep that line as it is; add new lines for what you learned.',
            );
          }
        }
      }
    } else {
      if (next !== null) {
        const type = frontmatterValue(next, 'type');
        if (!type || !DELEGATED_TYPES.includes(type)) {
          return refuse(
            'memory_type_not_allowed',
            `A memory written by this session needs frontmatter \`metadata.type\` of project or reference${type ? ` (got "${type}")` : ' (none found)'}.`,
            'Add a frontmatter block with metadata.type: project or reference. Preferences and feedback are a person’s to record.',
          );
        }
      }
      if (prior !== null && !isAgentOwned(prior)) {
        return refuse(
          'memory_owned_by_person',
          `${rel} is not a memory this session wrote. ${OWNED_BY_PERSON}`,
          'Write a new memory file instead.',
        );
      }
    }
  }

  if (next === null) return { ok: true, content: null, warnings: [] };

  const warnings: string[] = [];
  let content = next;

  // 4. Provenance stamp: topic files only; the index is the model's own and carries none.
  if (!isIndex) {
    const stamped = stamp(next, { sessionId: memory.sessionId, driver: learnings });
    content = stamped.text;
    if (stamped.warning) warnings.push(stamped.warning);
  }

  // 5. Warnings, which never refuse.
  if (isIndex) {
    const trimmed = content.trim();
    const lines = trimmed.length > 0 ? trimmed.split('\n').length : 0;
    const bytes = Buffer.byteLength(trimmed);
    if (lines > DEFAULT_MAX_INDEX_LINES || bytes > MAX_INDEX_BYTES) {
      warnings.push(
        `MEMORY.md is ${lines} lines and ${bytes} bytes; only the first ${DEFAULT_MAX_INDEX_LINES} lines or ${MAX_INDEX_BYTES} bytes load in a new session. Merge entries and keep each to one line.`,
      );
    }
    const missing = normalizeLines(content).flatMap((line) => {
      const target = entryTarget(line);
      return target !== undefined && readMemoryFile(memory.root, target) === null ? [target] : [];
    });
    if (missing.length > 0) {
      warnings.push(
        `MEMORY.md points to ${[...new Set(missing)].join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not exist in the memory directory (yet).`,
      );
    }
  } else if (Buffer.byteLength(content) > TOPIC_FILE_WARN_BYTES) {
    warnings.push(
      `${rel} is ${Buffer.byteLength(content)} bytes; keep a memory file under ${TOPIC_FILE_WARN_BYTES} bytes (one fact per file).`,
    );
  }

  return { ok: true, content, warnings };
}

/** The tool result text with the guard's warnings appended. */
export function withMemoryWarnings(content: string, warnings: readonly string[]): string {
  return warnings.length === 0
    ? content
    : `${content}\n\n${warnings.map((w) => `Warning: ${w}`).join('\n')}`;
}
