import type { Message, RetryPhase, ToolCall } from '../types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { parseMcpToolName } from './tool-presentation.js';

export type ActivityTone = 'normal' | 'waiting' | 'warning';

export interface WorkingActivity {
  label: string;
  tone: ActivityTone;
  blocked?: boolean;
}

interface WorkingActivityInput {
  isThinking: boolean;
  isCompacting: boolean;
  compactTrigger?: 'manual' | 'auto';
  messages: Message[];
  streamingMessageId?: string | null;
  pendingPermission: boolean;
  pendingPlanApproval: boolean;
  pendingUserQuestion: boolean;
  retryPhase: RetryPhase;
  retryAttempt: number;
  retryMax: number;
  retryCountdownMs: number;
  elapsedSeconds: number;
}

const REASONING_PHASES = [
  'Pondering the plot twist',
  'Consulting the footnotes',
  'Untangling a suspicious subplot',
  'Sharpening a very small pencil',
  'Rearranging the mental bookshelves',
  'Following a trail of semicolons',
  'Asking the rubber duck',
  'Turning the problem sideways',
  'Connecting dots in invisible ink',
  'Negotiating with the edge cases',
  'Chasing a runaway thought',
  'Preparing a tasteful plot twist',
] as const;

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function cleanTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || undefined;
}

function withTarget(action: string, target: string | undefined): string {
  const clean = cleanTarget(target);
  return clean ? `${action} ${clean}` : action;
}

function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

function pickPhrase(call: ToolCall, phrases: readonly string[]): string {
  const seed = `${call.name}:${call.id}:${getPrimaryArg(call.arguments)}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0;
  }
  return phrases[hash % phrases.length];
}

function playfulTarget(call: ToolCall, phrases: readonly string[], target: string | undefined) {
  return withTarget(pickPhrase(call, phrases), target);
}

export function toolActivityText(call: ToolCall): string {
  const canonicalName = canonicalToolName(call.name);
  const args = call.arguments;
  const primary = getPrimaryArg(args);
  const mcp = parseMcpToolName(call.name);

  if (mcp) {
    return withTarget(
      pickPhrase(call, [
        `Calling on ${mcp.server} to`,
        `Asking ${mcp.server} to`,
        `Waking ${mcp.server} up to`,
      ]),
      mcp.tool,
    );
  }

  switch (canonicalName) {
    case 'Read':
      return playfulTarget(
        call,
        ['Cracking open', 'Leafing through', 'Peeking between the covers of'],
        stringArg(args, 'filePath', 'file_path', 'path') ?? primary,
      );
    case 'Write':
      return playfulTarget(
        call,
        ['Putting ink to', 'Drafting a fresh page in', 'Filling the blank page in'],
        stringArg(args, 'filePath', 'file_path', 'path') ?? primary,
      );
    case 'Edit':
    case 'MultiEdit':
      return playfulTarget(
        call,
        ['Redlining', 'Polishing the prose in', 'Rewriting a stubborn paragraph in'],
        stringArg(args, 'filePath', 'file_path', 'path') ?? primary,
      );
    case 'NotebookEdit':
      return playfulTarget(
        call,
        ['Scribbling in notebook', 'Adding marginalia to', 'Annotating the notebook'],
        stringArg(args, 'notebook_path', 'path') ?? primary,
      );
    case 'Glob':
      return playfulTarget(
        call,
        ['Scanning the shelves for', 'Checking every book spine for', 'Roaming the stacks for'],
        stringArg(args, 'pattern') ?? primary,
      );
    case 'Grep':
      return playfulTarget(
        call,
        ['Hunting between the lines for', 'Following a trail of', 'Interrogating the code for'],
        stringArg(args, 'pattern') ?? primary,
      );
    case 'Bash':
      return playfulTarget(
        call,
        ['Rattling the terminal with', 'Whispering to the shell:', 'Letting the terminal chew on'],
        primary,
      );
    case 'BashOutput':
      return playfulTarget(
        call,
        ['Listening to shell', 'Eavesdropping on shell', 'Checking what came back from shell'],
        primary,
      );
    case 'KillShell':
      return playfulTarget(
        call,
        ['Quieting shell', 'Pulling the plug on shell', 'Showing the exit to shell'],
        primary,
      );
    case 'WebFetch':
      return playfulTarget(
        call,
        ['Pulling a page from', 'Borrowing a page from', 'Fetching fresh ink from'],
        stringArg(args, 'url') ?? primary,
      );
    case 'WebSearch':
      return playfulTarget(
        call,
        [
          'Roaming the web for',
          'Consulting the internet oracle about',
          'Following links in search of',
        ],
        stringArg(args, 'query') ?? primary,
      );
    case 'GitStatus':
      return pickPhrase(call, [
        "Taking the repo's pulse",
        'Checking whether Git looks nervous',
        'Asking Git what changed',
      ]);
    case 'GitDiff':
      return pickPhrase(call, [
        "Reading the diff's red ink",
        'Inspecting the editorial marks',
        'Comparing before and after',
      ]);
    case 'GitLog':
      return pickPhrase(call, [
        'Flipping through Git history',
        "Reading the repository's diary",
        'Checking old plot twists',
      ]);
    case 'GitCommit':
      return pickPhrase(call, [
        'Binding the changes into a commit',
        'Stamping a bookmark into Git',
        'Saving this chapter to history',
      ]);
    case 'GitBranch':
      return pickPhrase(call, [
        "Following Git's branches",
        'Climbing the branch tree',
        'Checking alternate timelines',
      ]);
    case 'TodoWrite':
      return pickPhrase(call, [
        'Rewriting the checklist',
        'Shuffling the plot points',
        'Updating the quest log',
      ]);
    case 'Task':
      return playfulTarget(
        call,
        ['Handing off a subplot:', 'Sending out a side quest:', 'Recruiting help for:'],
        stringArg(args, 'subject', 'description', 'prompt', 'agent') ?? primary,
      );
    case 'TaskCreate':
      return playfulTarget(
        call,
        ['Adding a plot point:', 'Pinning a new quest:', 'Writing a fresh task card:'],
        stringArg(args, 'subject') ?? primary,
      );
    case 'TaskList':
      return pickPhrase(call, [
        'Checking the plot points',
        'Reviewing the quest log',
        'Counting unfinished chapters',
      ]);
    case 'TaskGet':
      return playfulTarget(
        call,
        ['Opening plot point', 'Checking quest', 'Reading the task card for'],
        primary,
      );
    case 'TaskUpdate':
      return playfulTarget(
        call,
        ['Revising plot point', 'Moving quest along', 'Updating the task card for'],
        primary,
      );
    case 'TaskStop':
      return playfulTarget(
        call,
        ['Dropping plot point', 'Calling off quest', 'Closing the task card for'],
        primary,
      );
    case 'InvokeSkill':
      return playfulTarget(
        call,
        ['Opening the playbook for', 'Equipping the skill', 'Dusting off the manual for'],
        stringArg(args, 'skill') ?? primary,
      );
    case 'AskUserQuestion':
      return pickPhrase(call, [
        'Composing a thoughtful question',
        'Preparing a tiny pop quiz',
        'Choosing the least annoying question',
      ]);
    case 'EnterPlanMode':
      return pickPhrase(call, [
        'Outlining the next chapter',
        'Unrolling the planning parchment',
        'Sketching the treasure map',
      ]);
    case 'ExitPlanMode':
      return pickPhrase(call, [
        'Closing the outline',
        'Folding up the treasure map',
        'Putting the plan into motion',
      ]);
    case 'SessionHistorySearch':
      return playfulTarget(
        call,
        [
          'Flipping back through the story for',
          'Searching earlier chapters for',
          'Checking the recap for',
        ],
        stringArg(args, 'query') ?? primary,
      );
    case 'SessionHistoryRead':
      return pickPhrase(call, [
        'Re-reading an earlier chapter',
        'Catching up on the lore',
        'Consulting the previous episode',
      ]);
    default: {
      const toolName = humanizeToolName(canonicalName) || 'a tool';
      if (!primary) {
        return pickPhrase(call, [
          `Trying ${toolName}`,
          `Giving ${toolName} a whirl`,
          `Letting ${toolName} have a go`,
        ]);
      }
      return withTarget(
        pickPhrase(call, [
          `Trying ${toolName} on`,
          `Giving ${toolName} a whirl on`,
          `Letting ${toolName} have a go at`,
        ]),
        primary,
      );
    }
  }
}

function queuedActivity(label: string, count: number): string {
  if (count <= 1) return label;
  const waiting = count - 1;
  return `${label} · ${waiting} ${waiting === 1 ? 'tool' : 'tools'} in the wings`;
}

function activeToolText(message: Message | undefined): string | null {
  if (!message) return null;

  const pendingNested = (message.nestedToolInvocations ?? []).filter(
    (invocation) => !invocation.result,
  );
  if (pendingNested.length > 0) {
    const active = pendingNested[pendingNested.length - 1];
    return queuedActivity(toolActivityText(active.call), pendingNested.length);
  }

  const completed = new Set((message.toolResults ?? []).map((result) => result.toolCallId));
  const pending = (message.toolCalls ?? []).filter((call) => !completed.has(call.id));
  if (pending.length === 0) return null;
  return queuedActivity(toolActivityText(pending[0]), pending.length);
}

function retryText(
  phase: RetryPhase,
  attempt: number,
  max: number,
  countdownMs: number,
): string | null {
  if (phase === 'none') return null;

  const countdown = Math.max(0, Math.ceil(countdownMs / 1000));
  const attemptText = max > 0 ? `attempt ${attempt}/${max}` : `attempt ${attempt}`;

  if (phase === 'stalled') return `Waiting for API response · retrying in ${countdown}s`;
  if (phase === 'tool') return `Waiting for tool response · retrying in ${countdown}s`;
  if (phase === 'watchdog') return `Retrying watchdog · ${attemptText}`;
  return `Retrying in ${countdown}s · ${attemptText}`;
}

export function deriveWorkingActivity({
  isThinking,
  isCompacting,
  compactTrigger,
  messages,
  streamingMessageId,
  pendingPermission,
  pendingPlanApproval,
  pendingUserQuestion,
  retryPhase,
  retryAttempt,
  retryMax,
  retryCountdownMs,
  elapsedSeconds,
}: WorkingActivityInput): WorkingActivity | null {
  const retry = retryText(retryPhase, retryAttempt, retryMax, retryCountdownMs);
  if (retry) return { label: retry, tone: 'warning' };
  if (isCompacting) {
    return {
      label: compactTrigger === 'auto' ? 'Auto-compacting…' : 'Compacting…',
      tone: 'normal',
    };
  }
  if (!isThinking) return null;
  if (pendingPlanApproval) {
    return { label: 'Waiting for plan approval', tone: 'waiting', blocked: true };
  }
  if (pendingUserQuestion) {
    return { label: 'Waiting for your answer', tone: 'waiting', blocked: true };
  }
  if (pendingPermission) {
    return { label: 'Waiting for permission', tone: 'waiting', blocked: true };
  }

  const activeMessage = streamingMessageId
    ? messages.find((message) => message.id === streamingMessageId)
    : undefined;
  const toolText = activeToolText(activeMessage);
  if (toolText) return { label: toolText, tone: 'normal' };
  if (
    (activeMessage?.toolCalls?.length ?? 0) > 0 ||
    (activeMessage?.nestedToolInvocations?.length ?? 0) > 0
  ) {
    return { label: 'Reading what came back', tone: 'normal' };
  }
  if (activeMessage?.content) return { label: 'Writing the final page', tone: 'normal' };

  const phase = Math.floor(elapsedSeconds / 3) % REASONING_PHASES.length;
  return { label: REASONING_PHASES[phase], tone: 'normal' };
}
