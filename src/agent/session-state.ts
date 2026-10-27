import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import { peerEditSentence, promptAgo, promptSpan } from '../messaging/peer-text.js';
import { normalizeObservedPath, workspaceIdentity } from '../tools/file-provenance.js';
import { normalizePromptPath, promptCurrentDate, promptElapsed } from './prompt-determinism.js';
import type { FileChangeTracker } from '../tools/file-changes.js';
import type { Message } from '../types/messages.js';
import type {
  ChangedFileNotice,
  PeerAwarenessHandle,
  PeerSessionNote,
  PeerSessionsNotice,
} from '../types/messaging.js';
import type { FileObservation } from '../types/tools.js';
import { MAX_CHECKPOINT_FILES } from './compact.js';

/**
 * Per-turn workspace facts. They travel at the tail of the newest user turn
 * rather than in the system prompt: anything that changes every turn would sit
 * ahead of the message history in Anthropic's tools -> system -> messages cache
 * prefix and invalidate the whole conversation span behind it.
 *
 * A block is rendered once and never rewritten. Superseded snapshots stay in
 * history until compaction reclaims them.
 */

/** Cap the freshness pass so a large checkpoint cannot stall a turn on hashing. */

const PLAN_MODE_LINE =
  '- Plan mode: active — mutation tools are unavailable this turn; explore read-only, then call ExitPlanMode with your plan and wait for approval before making any file changes.';

export interface SessionStateInput {
  /** Workspace root, used to keep evaluation arms path-identical. */
  workspace: string;
  /** Rendered git summary, for example `branch main, clean`. Empty outside a worktree. */
  git?: string;
  planMode?: boolean;
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  /** Checkpoint files that no longer match what the agent observed. */
  staleFiles?: string[];
  /**
   * Set when a resumed session has prior work but no plan came back with it. An
   * empty todo list renders nothing at all, so without this line a restart that
   * dropped the plan is indistinguishable from a task that never had one — and
   * the model silently re-derives instead of deliberately rebuilding.
   */
  planUnrestored?: boolean;
  /** Milliseconds since this run began, rendered coarsely. */
  runElapsedMs?: number;
  /**
   * Agents this session delegated to that have not reached a terminal status.
   *
   * A background spawn returns as soon as the child is queued, so the turn that
   * delegated continues immediately with nothing in context to say the child is
   * still working. What the model does with that is narrate the handoff it
   * intended rather than the one that happened -- announcing a result it has
   * never seen, in a transcript that offers the user nothing to contradict it.
   * Restating the outstanding set every turn is the grounding that stops it.
   */
  outstandingAgents?: Array<{ label: string; status: string }>;
  /**
   * Observed files that changed on disk since the model last saw them (#620 4a): a user's edit, a
   * formatter, another session. Each is reported once per change, never for the model's own edits.
   */
  changedFiles?: ChangedFileNotice[];
  /** Changed files beyond those listed, counted only. */
  changedFilesUnlisted?: number;
  /** Other live Book sessions in this worktree and repository (#620 4c). */
  peers?: PeerSessionsNotice;
}

function changedFileLines(
  files: readonly ChangedFileNotice[],
  unlisted: number,
  workspace: string,
): string[] {
  if (files.length === 0 && unlisted === 0) return [];
  return [
    '## Changed on disk since you last read them',
    'That is usually deliberate, so take each as the current state rather than reverting it; if a change looks wrong, say so rather than undoing it yourself. Re-read a file before editing it.',
    ...files.flatMap((file) => {
      const path = normalizePromptPath(file.path, workspace);
      const what = file.deleted
        ? 'was deleted or moved since you last read it'
        : 'changed on disk since you last read it';
      const line = `- ${promptSpan(path)} ${what}.${
        file.attribution ? ` ${peerEditSentence(path, file.attribution)}` : ''
      }`;
      return file.snippet?.length
        ? [line, '  ```diff', ...file.snippet.map((text) => `  ${promptSpan(text)}`), '  ```']
        : [line];
    }),
    ...(unlisted > 0
      ? [
          `- ${unlisted} more observed file${unlisted === 1 ? '' : 's'} changed on disk as well; re-read any before relying on it.`,
        ]
      : []),
  ];
}

function peerNote(note: PeerSessionNote): string {
  const facts = [note.status, ...(note.branch ? [`branch ${note.branch}`] : [])].join(', ');
  const edits = note.edits.length
    ? `; recorded edits: ${note.edits.map((edit) => `${edit.path} ${promptAgo(edit.ageMs)}`).join(', ')}`
    : '';
  return promptSpan(`${note.name} (${facts}${edits})`);
}

function peerLines(peers: PeerSessionsNotice): string[] {
  const lines: string[] = [];
  if (peers.sameWorktree.length > 0) {
    const more = peers.moreSameWorktree > 0 ? `, and ${peers.moreSameWorktree} more` : '';
    lines.push(
      `- Other Book sessions in this worktree: ${peers.sameWorktree.map(peerNote).join('; ')}${more}. Their recorded edits are their own claims; check before relying on a file they touched.`,
    );
  }
  if (peers.otherWorktrees > 0) {
    lines.push(`- Book sessions in other worktrees of this repository: ${peers.otherWorktrees}`);
  }
  return lines;
}

function todoLines(todos: NonNullable<SessionStateInput['todos']>): string[] {
  if (todos.length === 0) return [];
  return [
    '## Current task list',
    ...todos.map((todo) => {
      const mark =
        todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[>]' : '[ ]';
      const active = todo.status === 'in_progress' && todo.activeForm;
      return `${mark} ${todo.content}${active ? ` (now: ${todo.activeForm})` : ''}`;
    }),
  ];
}

function outstandingAgentLines(
  agents: NonNullable<SessionStateInput['outstandingAgents']>,
): string[] {
  if (agents.length === 0) return [];
  return [
    '## Delegated agents still running',
    ...agents.map((agent) => `- ${agent.label} - ${agent.status}`),
    'No result from these has arrived yet. Do not state, summarize, or imply what they found until a completion is delivered to you.',
  ];
}

/**
 * Did this session lose a plan it used to have?
 *
 * The distinction the `plan` record type is built around: ABSENT means no plan was
 * ever written, PRESENT-BUT-EMPTY means one existed and came back with nothing.
 * Only the second is a loss. Testing emptiness alone told every resumed ordinary
 * conversation — one that simply never called TodoWrite — that its plan had not
 * survived, which pushes the model to invent a plan for a chat that never had one.
 *
 * Shared because both hosts compute it and they must not drift.
 */
export function planWasLost(input: {
  planRecordExisted: boolean;
  priorMessages: number;
  todos: number;
  tasks: number;
}): boolean {
  return (
    input.planRecordExisted && input.priorMessages > 0 && input.todos === 0 && input.tasks === 0
  );
}

export function renderSessionState(input: SessionStateInput): string {
  const stale = (input.staleFiles ?? []).map((path) => normalizePromptPath(path, input.workspace));
  const elapsed = input.runElapsedMs === undefined ? undefined : promptElapsed(input.runElapsedMs);

  return [
    '<session-state>',
    `- Current date: ${promptCurrentDate()}`,
    ...(elapsed ? [`- Running for: ${elapsed}`] : []),
    ...(input.git ? [`- Git: ${input.git}`] : []),
    ...(input.planMode ? [PLAN_MODE_LINE] : []),
    ...(stale.length
      ? [`- Stale since checkpoint: ${stale.join(', ')} — reread before exact reliance`]
      : []),
    ...(input.planUnrestored && (input.todos ?? []).length === 0
      ? [
          '- No task list was restored from the previous process, though this session has earlier work. Re-establish the plan before continuing.',
        ]
      : []),
    ...(input.peers ? peerLines(input.peers) : []),
    ...changedFileLines(input.changedFiles ?? [], input.changedFilesUnlisted ?? 0, input.workspace),
    ...outstandingAgentLines(input.outstandingAgents ?? []),
    ...todoLines(input.todos ?? []),
    '</session-state>',
  ].join('\n');
}

/** What the changed-on-disk and peer lines are read from (#620 PR 4). */
export interface WorkspaceNoticeSources {
  /** The session's memory of reported changes, beside the ledger it judges against. */
  tracker: FileChangeTracker;
  ledger: ReadonlyMap<string, FileObservation>;
  /** The TUI's view of other live sessions; absent elsewhere, and then no peer is named. */
  peerAwareness?: PeerAwarenessHandle;
  /**
   * Provider keys a diff snippet must not carry, read when the block renders: a Sign in with
   * ChatGPT token can rotate mid-run.
   */
  secrets?: () => readonly string[];
}

export interface WorkspaceNotices {
  notices: Pick<SessionStateInput, 'changedFiles' | 'changedFilesUnlisted' | 'peers'>;
  /** Mark the changes reported: call it once the block carrying them is rendered and kept. */
  commit(): void;
}

/**
 * The block's changed-on-disk notices (4a), each attributed to the peer whose recorded edit
 * matches it (4d), and the peer lines (4c). The two reads run side by side. A file the stale-since-
 * checkpoint line already names is left to that line.
 */
export async function collectWorkspaceNotices(
  workspace: string,
  sources: WorkspaceNoticeSources,
  staleFiles: readonly string[],
  signal?: AbortSignal,
): Promise<WorkspaceNotices> {
  const [changed, snapshot] = await Promise.all([
    sources.tracker
      .collect({
        ledger: sources.ledger,
        workspace,
        exclude: new Set(staleFiles.map(normalizeObservedPath)),
        secrets: sources.secrets?.(),
        signal,
      })
      // A notice is a courtesy: a check that cannot run must never fail the turn.
      .catch(() => ({ files: [], unlisted: 0, commit: () => {} })),
    sources.peerAwareness?.snapshot(),
  ]);
  const changedFiles = changed.files.map((file): ChangedFileNotice => {
    const attribution = snapshot?.attribute(file.absolutePath, file.observedAt);
    return {
      path: file.path,
      ...(file.deleted ? { deleted: true } : {}),
      ...(attribution ? { attribution } : {}),
      ...(file.snippet ? { snippet: file.snippet } : {}),
    };
  });
  return {
    notices: {
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      ...(changed.unlisted > 0 ? { changedFilesUnlisted: changed.unlisted } : {}),
      ...(snapshot?.notice ? { peers: snapshot.notice } : {}),
    },
    commit: changed.commit,
  };
}

interface CheckpointFileObservation {
  workspaceId?: string;
  sha256?: string;
  byteSize?: number;
  timestamp?: number;
}

interface CheckpointFile {
  path: string;
  observation?: CheckpointFileObservation;
}

/**
 * The files a checkpoint lists: v3 keeps them on the message's record; an older
 * checkpoint's content is the JSON itself, read leniently -- only `files` matters
 * here, and a document the full v2 schema would refuse still names them.
 */
function checkpointFilesOf(message: Message): { files?: CheckpointFile[] } | undefined {
  if (message.checkpointData) return message.checkpointData;
  const content = message.contextContent ?? message.content;
  const jsonStart = content.indexOf('{');
  if (jsonStart < 0) return undefined;
  try {
    return JSON.parse(content.slice(jsonStart)) as { files?: CheckpointFile[] };
  } catch {
    return undefined;
  }
}

/**
 * Report which checkpoint files drifted since the agent last observed them.
 *
 * The checkpoint's own bytes stay frozen — re-rendering an old message at build
 * time would change history behind the conversation cache breakpoint, and after
 * compaction the checkpoint sits at the head of history where that costs the most.
 */
export async function collectStaleCheckpointFiles(
  workspace: string,
  checkpointMessage: Message,
  /**
   * The newest observation of each path in the messages after the checkpoint,
   * keyed by `normalizeObservedPath`. Where it is newer than the checkpoint's
   * own, the file is judged against it: a file the agent edited after compacting
   * is not stale for that, while a change made on disk since is still reported.
   */
  observedSince: ReadonlyMap<string, CheckpointFileObservation> = new Map(),
): Promise<string[]> {
  const checkpoint = checkpointFilesOf(checkpointMessage);
  if (!checkpoint?.files?.length) return [];

  const currentWorkspaceId = workspaceIdentity(workspace);
  const hashes = new Map<string, string>();
  const stale: string[] = [];

  for (const file of checkpoint.files.slice(0, MAX_CHECKPOINT_FILES)) {
    const since = observedSince.get(normalizeObservedPath(file.path));
    const observation =
      since && (since.timestamp ?? 0) >= (file.observation?.timestamp ?? 0)
        ? since
        : file.observation;
    if (!observation?.sha256 || observation.workspaceId !== currentWorkspaceId) {
      stale.push(file.path);
      continue;
    }
    try {
      const absolute = resolve(workspace, file.path);
      const info = await stat(absolute);
      const key = `${absolute}:${info.size}:${info.mtimeMs}`;
      let hash = hashes.get(key);
      if (!hash) {
        hash = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
        hashes.set(key, hash);
      }
      if (hash !== observation.sha256) stale.push(file.path);
    } catch {
      // Missing files are stale locators.
      stale.push(file.path);
    }
  }

  return stale;
}
