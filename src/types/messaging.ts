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
  /** Optional capabilities the session offers peers. Empty until messaging lands. */
  features: string[];
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
