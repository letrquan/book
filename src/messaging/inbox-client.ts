/**
 * The sending half of the inbox: deliver one frame to another session's socket.
 *
 * A send authenticates with the receiver's token, read from its key file in the live-sessions
 * directory — `*.<sha256(socket path)>.key`, in this session's own pid domain only. The frame is
 * checked against the line cap before anything is opened, and a send that a mirror of the
 * receiver's rate limit says would be dropped is refused locally (`pacer.ts`).
 *
 * The protocol has no acknowledgement: `sent` means both lines went out and the receiver closed
 * cleanly. Whether the message was accepted comes back later, as a receipt to this session's own
 * inbox.
 */

import { readdir, readFile, lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { isAbsolute, join } from 'node:path';
import type { InboxSendResult } from '../types/messaging.js';
import { isRecordProcessLive, type LivenessProbe } from './liveness.js';
import type { SendPacer } from './pacer.js';
import {
  parseLiveSessionKey,
  parseLiveSessionKeyName,
  pidDomainTag,
  socketPathHash,
  type LiveSessionKey,
} from './registry.js';
import { exceedsLineCap, serializeFrame, type InboxFrame } from './wire.js';

/** How long a whole send may take, connect included, before it counts as `busy`. */
export const SEND_TIMEOUT_MS = 5_000;

export interface PeerKeyLookup {
  /** The live-sessions directory, where keys sit beside the records. */
  keysDir: string;
  socketPath: string;
  probe: LivenessProbe;
}

/**
 * The key for the inbox at `socketPath`, from this pid domain only. When several match — a pid
 * reused while an old key was still on disk — the one whose owner pid and start token are live
 * wins; failing that, the first valid one, and the connection decides.
 */
export async function findPeerKey(
  lookup: PeerKeyLookup,
): Promise<(LiveSessionKey & { pid: number; path: string }) | undefined> {
  const domain = await lookup.probe.pidDomain();
  const tag = domain === undefined ? undefined : pidDomainTag(domain);
  const hash = socketPathHash(lookup.socketPath);
  let names: string[];
  try {
    names = await readdir(lookup.keysDir);
  } catch {
    return undefined;
  }
  const candidates = names
    .map((name) => ({ name, parsed: parseLiveSessionKeyName(name) }))
    .filter(({ parsed }) => parsed !== undefined && parsed.hash === hash && parsed.tag === tag)
    .sort((a, b) => a.name.localeCompare(b.name));
  let fallback: (LiveSessionKey & { pid: number; path: string }) | undefined;
  for (const { name, parsed } of candidates) {
    const path = join(lookup.keysDir, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const key = parseLiveSessionKey(text);
    // The body has to agree with the name it sits under, or it is not this domain's key.
    if (!key || key.pidDomain !== domain) continue;
    const found = { ...key, pid: parsed!.pid, path };
    if (await isRecordProcessLive({ pid: found.pid, procStart: key.procStart }, lookup.probe)) {
      return found;
    }
    fallback ??= found;
  }
  return fallback;
}

export interface SendToInboxOptions extends PeerKeyLookup {
  frame: InboxFrame;
  /** The sender's pacer; a `user` frame is paced, a receipt is not. */
  pacer?: SendPacer;
  timeoutMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** A transport error, as the sender's tools will explain it. */
export function classifySendError(code: string | undefined): InboxSendResult {
  if (code === 'ENOENT' || code === 'ECONNREFUSED') {
    return { status: 'gone', detail: 'no session is listening at that socket any more' };
  }
  if (code === 'EAGAIN' || code === 'EBUSY' || code === 'ETIMEDOUT') {
    return { status: 'busy', detail: 'the receiving session did not take the connection in time' };
  }
  return { status: 'failed', detail: `the send failed (${code ?? 'unknown error'})` };
}

/** Deliver one frame to the inbox at `socketPath`. Never rejects. */
export async function sendToInbox(options: SendToInboxOptions): Promise<InboxSendResult> {
  const line = serializeFrame(options.frame);
  if (exceedsLineCap(line)) {
    return {
      status: 'message_too_large',
      detail:
        'the message is over the 1 MiB line limit; put bulk content in a file and send its path',
    };
  }
  if (!isAbsolute(options.socketPath)) {
    return { status: 'failed', detail: 'the address is not an absolute socket path' };
  }
  if (options.pacer && !options.pacer.take(options.socketPath)) {
    return {
      status: 'sender_paced',
      detail: 'too many messages to that session too quickly; batch what remains into one message',
    };
  }
  const result = await deliver(options, line);
  if (result.status !== 'sent') options.pacer?.refund(options.socketPath);
  return result;
}

async function deliver(options: SendToInboxOptions, line: string): Promise<InboxSendResult> {
  try {
    const info = await lstat(options.socketPath);
    if (!info.isSocket()) return { status: 'failed', detail: 'the address is not a socket' };
  } catch (error) {
    return classifySendError(errorCode(error));
  }
  const key = await findPeerKey(options);
  if (!key)
    return {
      status: 'gone',
      detail: 'no key for that session; it has ended or never opened an inbox',
    };
  const auth = serializeFrame({ type: 'auth', token: key.peerToken });
  return new Promise<InboxSendResult>((resolve) => {
    let settled = false;
    const finish = (result: InboxSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const socket = createConnection({ path: options.socketPath });
    const timer = setTimeout(
      () => finish(classifySendError('ETIMEDOUT')),
      options.timeoutMs ?? SEND_TIMEOUT_MS,
    );
    timer.unref?.();
    socket.once('connect', () => {
      socket.end(auth + line);
    });
    socket.on('error', (error) => finish(classifySendError(errorCode(error))));
    // Nothing is ever sent back on success; whatever the receiver writes is ignored.
    socket.on('data', () => undefined);
    socket.once('close', (hadError) => {
      if (!hadError) finish({ status: 'sent' });
    });
  });
}
