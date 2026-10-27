/**
 * The live-session registry: one record per running interactive Book session, at
 * `<BOOK_HOME>/live-sessions/<pid>.json`. It is discovery only — who is running, where, and
 * whether they are busy — and is the address book cross-session messaging (#620) reads later.
 */

/** What the session is doing, as another session would want to know before messaging it. */
export type LiveSessionStatus = 'busy' | 'waiting' | 'idle';

/** Why a `waiting` session is waiting: a tool approval, or an answer only the user can give. */
export type LiveSessionWaitingFor = 'permission prompt' | 'input needed';

/**
 * Where the record's name came from. Book writes `derived`, `collision` (the derived name was
 * re-rolled because a live session held it) and `user` (`BOOK_SESSION_NAME`); a reader accepts
 * the rest of Claude Code's set so a record a later version writes still parses.
 */
export type LiveSessionNameSource = 'user' | 'peer' | 'derived' | 'collision' | 'auto' | 'hook';

/** Only the interactive TUI registers in v1. */
export type LiveSessionKind = 'interactive';

export interface LiveSessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Epoch milliseconds when the session registered. */
  startedAt: number;
  /**
   * The process start token: field 22 of `/proc/<pid>/stat` on Linux, `ps -o lstart=` on macOS.
   * A live pid whose token differs is a reused pid, not this session. Absent where the platform
   * has no cheap source for it (Windows), and then liveness is the pid alone.
   */
  procStart?: string;
  /**
   * The pid namespace the pid is meaningful in (`linux:<machine id>:pid:[<inode>]`). A record from
   * another domain — a container sharing the home directory — is ignored, never swept.
   */
  pidDomain?: string;
  /** Book's version. */
  version: string;
  /** The registry format; bumped only for a change older readers cannot read. */
  protocol: number;
  /**
   * Optional capabilities the session offers peers: `inbox` while it accepts messages at
   * {@link messagingSocketPath}. Empty when messaging is off.
   */
  features: string[];
  /**
   * The session's inbox socket, canonical (its directory's symlinks resolved), present only while
   * messaging is on and the inbox is bound. The key a sender authenticates with is named after
   * this exact string.
   */
  messagingSocketPath?: string;
  kind: LiveSessionKind;
  /** The address other sessions will use, e.g. `book-3f`. */
  name: string;
  nameSource: LiveSessionNameSource;
  status: LiveSessionStatus;
  waitingFor?: LiveSessionWaitingFor;
  /** Epoch milliseconds of the last change to `status` or `waitingFor`. */
  statusUpdatedAt: number;
  /** Epoch milliseconds of the last write of any field. */
  updatedAt: number;
}

/**
 * A record as a reader takes it. Only the essentials are required: the pid, the session id, the
 * name and when it started. Every other field is kept as written and typed loosely, because a
 * later version may write values this one does not know (`kind: 'headless'`, a new status) — and
 * such a record must still count as a session for liveness, sweeping and name collisions.
 */
export interface ReadLiveSessionRecord {
  pid: number;
  sessionId: string;
  name: string;
  startedAt: number;
  procStart?: string;
  pidDomain?: string;
  updatedAt?: number;
  [field: string]: unknown;
}

/** Where the inbox's socket directory came from (`socket-dir.ts`). */
export type SocketDirSource = 'env' | 'book-home' | 'xdg-runtime' | 'tmp';

/** Why a socket directory was not used. */
export type SocketDirRefusalReason =
  | 'symlink'
  | 'symlink-loop'
  | 'not-directory'
  | 'not-owner'
  | 'loose-mode'
  | 'parent-not-owner'
  | 'parent-writable'
  | 'too-long'
  | 'unavailable';

/**
 * Why the receiving inbox dropped a peer message, in Claude Code's words (`drop_reason` on a
 * `peer_message_status` receipt).
 */
export type PeerDropReason =
  'rate-limited' | 'duplicate' | 'hop-loop' | 'hop-runaway' | 'queue-full';

/** A `user` frame the inbox accepted, waiting for the session to take it (PR 3 delivers it). */
export interface AcceptedPeerMessage {
  /** The message body: the envelope the sender wrapped its text in. */
  content: string;
  /** The sender's reply address, `uds:<socket path>`, as the frame gave it. Unverified. */
  from?: string;
  msgId?: string;
  priority?: string;
  /** Epoch milliseconds when the inbox accepted it. */
  receivedAt: number;
}

/** A `peer_message_status` receipt another session sent back about a message this one sent. */
export interface PeerMessageReceipt {
  status: string;
  origMsgId?: string;
  dropReason?: string;
  droppedMsgIds?: string[];
  reason?: string;
  from?: string;
  receivedAt: number;
}

/** How the inbox start ended. A failure never stops the session; it is reported once. */
export type InboxStartResult =
  | {
      status: 'listening';
      socketPath: string;
      movedAside: boolean;
      /** Socket directories refused on the way, each with its remediation (`book doctor` too). */
      refusedDirs: string[];
    }
  | { status: 'failed'; message: string };

/**
 * What a send to another session's inbox came to.
 *
 * - `sent`: both lines were written and the receiver closed cleanly. Not proof of delivery: the
 *   receiver may still drop it, and says so with a receipt.
 * - `gone`: no session listens there any more (ENOENT, ECONNREFUSED, or no key to authenticate).
 * - `busy`: the receiver did not take the connection in time (EAGAIN, EBUSY, a timeout).
 * - `message_too_large`: the frame is over the line cap; checked before connecting.
 * - `sender_paced`: this session's own mirror of the receiver's rate limit refused it.
 * - `failed`: anything else, with the error code.
 */
export type InboxSendResult =
  | { status: 'sent' }
  | { status: 'gone' | 'busy' | 'message_too_large' | 'sender_paced' | 'failed'; detail: string };
