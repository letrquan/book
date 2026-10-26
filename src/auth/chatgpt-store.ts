/**
 * The Sign in with ChatGPT credential record: one file under `BOOK_HOME`, never a workspace file.
 *
 * It holds the agent host id (chosen once, before the first sign-in, and kept after sign-out),
 * the OAuth client OpenAI issued for this host, the account it is bound to, and that account's
 * tokens. The file is written atomically from a temporary file created with mode 0600, so the
 * tokens are never readable by another user, not even for the moment of a write.
 *
 * The name is new on purpose: `auth.json` is the 0.3 store `settings-removed.ts` reports as an
 * orphaned leftover, and that report must stay true.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { delay } from '../async.js';
import { resolveBookHome } from '../book-home.js';
import { writeFileAtomic } from '../settings-repository.js';

export const CHATGPT_SIGNIN_FILENAME = 'chatgpt-signin.json';

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  /** When the access token expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** OpenAI's `earliest_refresh_at`, when it sent one (milliseconds). */
  earliestRefreshAt?: number;
  scopes: string[];
  savedAt: number;
}

export interface ChatGptAccount {
  /** The client OpenAI issued at registration (`oaiapp_…`), never `dynamic_agent_client`. */
  clientId: string;
  /** The validated ID token's `sub`: the account this registration is bound to. */
  subject: string;
  /** The ID token's `email`, for `book auth status`; not an identifier. */
  email?: string;
  /** Absent after sign-out: the registration is kept, so the next sign-in reuses it. */
  tokens?: ChatGptTokens;
}

export interface ChatGptSigninRecord {
  version: 1;
  /** `ext_agent_host_id`: an opaque `urn:uuid:` value, never an email or account id. */
  hostId: string;
  account?: ChatGptAccount;
  /** Whether the first-sign-in notice about plan usage has been shown. */
  welcomed?: boolean;
}

export function chatGptSigninPath(home: string = resolveBookHome()): string {
  return join(home, CHATGPT_SIGNIN_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function parseTokens(value: unknown): ChatGptTokens | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = stringOr(value.accessToken);
  const idToken = stringOr(value.idToken);
  if (!accessToken || !idToken || typeof value.expiresAt !== 'number') return undefined;
  return {
    accessToken,
    idToken,
    ...(stringOr(value.refreshToken) ? { refreshToken: value.refreshToken as string } : {}),
    expiresAt: value.expiresAt,
    ...(typeof value.earliestRefreshAt === 'number'
      ? { earliestRefreshAt: value.earliestRefreshAt }
      : {}),
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
  };
}

/**
 * The record at `path`, or undefined when there is none. A file that does not parse as a record
 * is reported, never silently replaced: it may hold a refresh token someone needs to revoke.
 */
export function readChatGptSignin(path: string): ChatGptSigninRecord | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'Delete it and sign in again with `book auth login`.',
    );
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !stringOr(parsed.hostId)) {
    throw new Error(
      `${path} is not a Sign in with ChatGPT record. Delete it and sign in again with \`book auth login\`.`,
    );
  }
  const account = isRecord(parsed.account) ? parsed.account : undefined;
  const clientId = stringOr(account?.clientId);
  const subject = stringOr(account?.subject);
  return {
    version: 1,
    hostId: parsed.hostId as string,
    ...(account && clientId && subject
      ? {
          account: {
            clientId,
            subject,
            ...(stringOr(account.email) ? { email: account.email as string } : {}),
            ...(parseTokens(account.tokens) ? { tokens: parseTokens(account.tokens) } : {}),
          },
        }
      : {}),
    ...(parsed.welcomed === true ? { welcomed: true } : {}),
  };
}

export function writeChatGptSignin(path: string, record: ChatGptSigninRecord): void {
  writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

/** The record, creating it with a fresh host id first when there is none. */
export function ensureChatGptSignin(path: string): ChatGptSigninRecord {
  const existing = readChatGptSignin(path);
  if (existing) return existing;
  const record: ChatGptSigninRecord = { version: 1, hostId: `urn:uuid:${randomUUID()}` };
  writeChatGptSignin(path, record);
  return record;
}

/** The access, refresh and ID tokens of the record at `path`, for secret redaction. */
export function chatGptTokenSecrets(path: string): string[] {
  try {
    const tokens = readChatGptSignin(path)?.account?.tokens;
    return tokens
      ? [tokens.accessToken, tokens.idToken, tokens.refreshToken].filter((token): token is string =>
          Boolean(token),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * A lock older than this was left by a process that died holding it. A holder makes one token
 * request (20 s at most) and one write, so two minutes is never a live holder; the age is the
 * file's mtime, so an empty lock (a crash between creating and writing it) is reclaimed too.
 */
const STALE_LOCK_MS = 2 * 60_000;
/** How long a waiter waits: past a live holder's longest request, short of a stale lock. */
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 50;

function lockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS;
  } catch {
    // Removed meanwhile: not stale, and the next attempt takes it.
    return false;
  }
}

/**
 * Run `fn` holding the record's lock file, across processes. Refresh tokens rotate, so two
 * sessions refreshing at once would each spend the token the other needs; the one that waits
 * re-reads the record inside the lock and finds the tokens already renewed. The lock holds a
 * random token, and is removed only while it still holds this holder's, so a holder whose lock
 * was reclaimed as stale never removes the next holder's.
 */
export async function withChatGptSigninLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const owner = `${process.pid} ${randomUUID()}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeSync(descriptor, owner);
      closeSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        // Created but not written: remove it rather than leave a lock nobody owns.
        closeSync(descriptor);
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another waiter removed it first.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${lockPath}; delete it if no Book process is running.`,
        );
      }
      await delay(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath);
    } catch {
      // Already gone, or reclaimed by another holder.
    }
  }
}
