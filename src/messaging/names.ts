/**
 * The name a live session registers under: the address other sessions will use for it.
 *
 * Derived from the workspace the way Claude Code derives its own (`<slug(basename cwd)>-<2 hex>`,
 * so `book-3f`), and re-rolled when a live session already holds it. `BOOK_SESSION_NAME` names the
 * session instead. Book has no `/rename`.
 */

import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { LiveSessionNameSource } from '../types/messaging.js';

/** The stem used when the workspace's name has nothing a slug can keep (`/`, `C:\`, `日本`). */
export const DEFAULT_NAME_STEM = 'book';

const MAX_SLUG_LENGTH = 32;
/** Names tried per suffix width: two hex digits first, then four. */
const SUFFIX_ATTEMPTS = 32;

/** Lowercase ASCII letters, digits and single hyphens; empty when nothing survives. */
export function slugifySessionName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

export interface DeriveLiveSessionNameOptions {
  cwd: string;
  /** Names live sessions hold now; a derived name never repeats one. */
  liveNames: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  /** One random byte, 0–255. Injected so tests can force a collision. */
  randomByte?: () => number;
}

export interface DerivedLiveSessionName {
  name: string;
  nameSource: Extract<LiveSessionNameSource, 'user' | 'derived' | 'collision'>;
}

function hex(byte: number): string {
  return (byte & 0xff).toString(16).padStart(2, '0');
}

/**
 * The session's name. `BOOK_SESSION_NAME` wins, slugged like a derived name so it stays a usable
 * address, and is kept even when a live session holds it: the user chose it. Otherwise the stem is
 * the workspace's slug, and the suffix is re-rolled until no live session holds the name —
 * `nameSource: 'collision'` records that it was.
 */
export function deriveLiveSessionName(
  options: DeriveLiveSessionNameOptions,
): DerivedLiveSessionName {
  const randomByte = options.randomByte ?? (() => randomBytes(1)[0]!);
  const requested = slugifySessionName(options.env?.BOOK_SESSION_NAME ?? '');
  if (requested) return { name: requested, nameSource: 'user' };

  const stem = slugifySessionName(basename(options.cwd)) || DEFAULT_NAME_STEM;
  let name = `${stem}-${hex(randomByte())}`;
  if (!options.liveNames.has(name)) return { name, nameSource: 'derived' };
  for (let attempt = 1; attempt < SUFFIX_ATTEMPTS; attempt++) {
    name = `${stem}-${hex(randomByte())}`;
    if (!options.liveNames.has(name)) return { name, nameSource: 'collision' };
  }
  // 256 names per stem is a limit a busy machine can reach; four hex digits is 65,536. Still
  // bounded: a name shared with a live session is an ambiguity, never a reason to hang startup.
  for (let attempt = 0; attempt < SUFFIX_ATTEMPTS; attempt++) {
    name = `${stem}-${hex(randomByte())}${hex(randomByte())}`;
    if (!options.liveNames.has(name)) break;
  }
  return { name, nameSource: 'collision' };
}
