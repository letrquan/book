import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import { workspaceIdentity } from '../tools/file-provenance.js';
import { normalizePromptPath, promptCurrentDate, promptElapsed } from './prompt-determinism.js';

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
const MAX_CHECKPOINT_FILES = 30;

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
    ...todoLines(input.todos ?? []),
    '</session-state>',
  ].join('\n');
}

interface CheckpointFile {
  path: string;
  observation?: { workspaceId?: string; sha256?: string; byteSize?: number };
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
  checkpointContent: string,
): Promise<string[]> {
  const jsonStart = checkpointContent.indexOf('{');
  if (jsonStart < 0) return [];

  let checkpoint: { files?: CheckpointFile[] };
  try {
    checkpoint = JSON.parse(checkpointContent.slice(jsonStart));
  } catch {
    return [];
  }
  if (!checkpoint.files?.length) return [];

  const currentWorkspaceId = workspaceIdentity(workspace);
  const hashes = new Map<string, string>();
  const stale: string[] = [];

  for (const file of checkpoint.files.slice(0, MAX_CHECKPOINT_FILES)) {
    const observation = file.observation;
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
