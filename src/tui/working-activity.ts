import type { Message } from '../types/messages.js';
import type { RetryPhase } from '../types/runtime.js';
import type { ToolCall } from '../types/tools.js';
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

/**
 * Widest a phrase may be, in columns.
 *
 * The activity row is one line and the label shares it with an elapsed time and
 * a keyboard hint — about 50 columns on an 80-column terminal. A phrase is only
 * the frame; the target inside it (a path, a pattern, a shell command) is the
 * part the reader is actually waiting to see. `Peeking between the covers of`
 * spent 29 of those columns on a joke and then truncated the filename it was
 * introducing. Short phrases are funnier anyway: the gag lands before the eye
 * has finished the line, and what the run is *doing* survives.
 */
export const MAX_PHRASE_WIDTH = 28;

/**
 * The reasoning phases.
 *
 * Shown while the model is thinking and nothing more specific is known, one
 * every three seconds, in this order — so the openers are the ones a short turn
 * will actually show. Each line is a small joke about *thinking*, never a claim
 * about progress the run has not made: `Almost there` would be a lie the
 * indicator has no way to check.
 */
export const REASONING_PHASES = [
  'Pondering the plot twist',
  'Consulting the footnotes',
  'Untangling a subplot',
  'Sharpening a tiny pencil',
  'Rearranging the bookshelves',
  'Following the semicolons',
  'Asking the rubber duck',
  'Turning it sideways',
  'Reading between the lines',
  'Negotiating with edge cases',
  'Chasing a runaway thought',
  'Auditioning better verbs',
  'Squinting at the margins',
  'Arguing with a footnote',
  'Letting the ink dry',
  'Rereading that paragraph',
  'Hunting a missing comma',
  'Blaming the typesetter',
  'Checking the index twice',
  'Dog-earing the good bit',
  'Filing off a rough edge',
  'Weighing two adjectives',
  'Drafting in the margins',
  'Counting the loose ends',
  'Consulting the errata',
  'Retracing the outline',
  'Second-guessing chapter two',
  'Plotting the next twist',
] as const;

/**
 * One phrase list per tool.
 *
 * Kept in a single catalog rather than inline in the switch so the set can be
 * read — and width-checked — in one place. Phrases that take a target end where
 * the target begins, so they read as one clause: `Redlining src/tui/app.tsx`,
 * `Chewing on npm test`.
 */
const TOOL_PHRASES = {
  read: ['Cracking open', 'Leafing through', 'Skimming', 'Peeking inside'],
  write: ['Putting ink to', 'Drafting', 'Inking'],
  applyPatch: ['Patching', 'Stitching an edit into', 'Reworking'],
  edit: ['Redlining', 'Polishing', 'Rewording', 'Marking up'],
  notebookEdit: ['Scribbling in', 'Annotating', 'Adding marginalia to'],
  glob: ['Scanning shelves for', 'Checking spines for', 'Combing the stacks for'],
  grep: ['Hunting for', 'Combing the lines for', 'Tracking down', 'Grilling the code for'],
  bash: ['Running', 'Poking the shell with', 'Chewing on'],
  bashOutput: ['Listening to shell', 'Eavesdropping on shell', 'Checking in on shell'],
  killShell: ['Quieting shell', 'Hushing shell', 'Pulling the plug on shell'],
  dismissShell: ['Clearing shell', 'Filing away shell', 'Tidying up shell'],
  webFetch: ['Fetching', 'Pulling a page from', 'Borrowing ink from'],
  webSearch: ['Roaming the web for', 'Chasing links for', 'Asking the internet about'],
  gitStatus: [
    "Taking the repo's pulse",
    'Asking Git what changed',
    'Seeing if Git looks nervous',
    "Reading the repo's mood",
  ],
  gitDiff: ['Reading the red ink', 'Studying the markup', 'Comparing drafts'],
  gitLog: ['Flipping through history', "Reading the repo's diary", 'Checking old plot twists'],
  gitCommit: ['Binding the chapter', 'Stamping a bookmark', 'Filing this chapter away'],
  gitBranch: ["Following Git's branches", 'Climbing the branches', 'Checking other timelines'],
  todoWrite: ['Redrawing the plan', 'Shuffling the plot points', 'Updating the quest log'],
  task: ['Handing off a subplot:', 'Sending a side quest:', 'Recruiting help for:'],
  taskCreate: ['Adding a plot point:', 'Pinning a new quest:', 'Writing a task card:'],
  taskList: ['Checking the plot points', 'Reviewing the quest log', 'Counting loose ends'],
  taskGet: ['Opening plot point', 'Checking quest', 'Reading the card for'],
  taskUpdate: ['Revising plot point', 'Moving quest along', 'Updating the card for'],
  taskStop: ['Dropping plot point', 'Calling off quest', 'Closing the card for'],
  invokeSkill: ['Opening the playbook:', 'Equipping', 'Dusting off'],
  readSkillResource: ['Turning to', 'Opening', 'Consulting'],
  toolSearch: ['Rummaging the toolbox for', 'Sizing up tools for', 'Hunting a tool for'],
  askUserQuestion: ['Composing a question', 'Preparing a tiny pop quiz', 'Wording it carefully'],
  enterPlanMode: [
    'Outlining the next chapter',
    'Unrolling the parchment',
    'Sketching the treasure map',
  ],
  exitPlanMode: ['Closing the outline', 'Folding the treasure map', 'Setting the plan in motion'],
  sessionHistorySearch: [
    'Flipping back for',
    'Searching old chapters for',
    'Checking the recap for',
  ],
  sessionHistoryRead: [
    'Rereading an old chapter',
    'Catching up on the lore',
    'Checking last episode',
  ],
  agentPlan: ['Planning the handoff', 'Drawing up the roster', 'Casting the chapter'],
  agentSpawn: ['Commissioning:', 'Handing off:', 'Hiring a ghostwriter:'],
  agentList: ['Counting the ghostwriters', 'Taking attendance', 'Checking the writers room'],
  agentGet: ['Checking on agent', 'Asking after agent', 'Looking in on agent'],
  agentRead: ['Reading back agent', 'Collecting notes from', 'Opening the report from'],
  agentSend: ['Passing a note:', 'Nudging the agent:', 'Sending word:'],
  agentWait: ['Waiting on agent', 'Holding for agent', 'Letting agent finish'],
  agentStop: ['Calling back agent', 'Stopping agent', 'Pulling agent off the job'],
  agentApply: ['Accepting the patch', 'Taking the draft', 'Folding in the patch'],
  evidencePublish: ['Filing evidence:', 'Pinning up:', 'Logging the receipt:'],
  evidenceList: ['Checking the evidence', 'Counting the receipts', 'Reviewing the exhibits'],
  evidenceReview: ['Weighing the evidence', 'Reading the exhibits', 'Second-opinioning'],
} as const;

/** Every static phrase list in this module, for the width budget check. */
export const ACTIVITY_PHRASE_LISTS: readonly (readonly string[])[] = [
  REASONING_PHASES,
  ...Object.values(TOOL_PHRASES),
];

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
  if (!clean) return action.endsWith(':') ? action.slice(0, -1) : action;
  return `${action} ${clean}`;
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
  const filePath = stringArg(args, 'filePath', 'file_path', 'path') ?? primary;
  const mcp = parseMcpToolName(call.name);

  if (mcp) {
    return withTarget(
      pickPhrase(call, [
        `Asking ${mcp.server} to`,
        `Nudging ${mcp.server} to`,
        `Calling on ${mcp.server} to`,
      ]),
      mcp.tool,
    );
  }

  switch (canonicalName) {
    case 'Read':
      return playfulTarget(call, TOOL_PHRASES.read, filePath);
    case 'Write':
      return playfulTarget(call, TOOL_PHRASES.write, filePath);
    case 'ApplyPatch':
      // `getPrimaryArg` digs the touched file out of the `*** Update File:`
      // envelope, so the row can name it instead of saying `workspace files`.
      return playfulTarget(call, TOOL_PHRASES.applyPatch, primary);
    case 'Edit':
    case 'MultiEdit':
      return playfulTarget(call, TOOL_PHRASES.edit, filePath);
    case 'NotebookEdit':
      return playfulTarget(
        call,
        TOOL_PHRASES.notebookEdit,
        stringArg(args, 'notebook_path', 'path') ?? primary,
      );
    case 'Glob':
      return playfulTarget(call, TOOL_PHRASES.glob, stringArg(args, 'pattern') ?? primary);
    case 'Grep':
      return playfulTarget(call, TOOL_PHRASES.grep, stringArg(args, 'pattern') ?? primary);
    case 'Bash':
      return playfulTarget(call, TOOL_PHRASES.bash, primary);
    case 'BashOutput':
      return playfulTarget(call, TOOL_PHRASES.bashOutput, primary);
    case 'KillShell':
      return playfulTarget(call, TOOL_PHRASES.killShell, primary);
    case 'DismissShell':
      return playfulTarget(call, TOOL_PHRASES.dismissShell, primary);
    case 'WebFetch':
      return playfulTarget(call, TOOL_PHRASES.webFetch, stringArg(args, 'url') ?? primary);
    case 'WebSearch':
      return playfulTarget(call, TOOL_PHRASES.webSearch, stringArg(args, 'query') ?? primary);
    case 'GitStatus':
      return pickPhrase(call, TOOL_PHRASES.gitStatus);
    case 'GitDiff':
      return pickPhrase(call, TOOL_PHRASES.gitDiff);
    case 'GitLog':
      return pickPhrase(call, TOOL_PHRASES.gitLog);
    case 'GitCommit':
      return pickPhrase(call, TOOL_PHRASES.gitCommit);
    case 'GitBranch':
      return pickPhrase(call, TOOL_PHRASES.gitBranch);
    case 'TodoWrite':
      return pickPhrase(call, TOOL_PHRASES.todoWrite);
    case 'Task':
      return playfulTarget(
        call,
        TOOL_PHRASES.task,
        stringArg(args, 'subject', 'description', 'prompt', 'agent') ?? primary,
      );
    case 'TaskCreate':
      return playfulTarget(call, TOOL_PHRASES.taskCreate, stringArg(args, 'subject') ?? primary);
    case 'TaskList':
      return pickPhrase(call, TOOL_PHRASES.taskList);
    case 'TaskGet':
      return playfulTarget(call, TOOL_PHRASES.taskGet, primary);
    case 'TaskUpdate':
      return playfulTarget(call, TOOL_PHRASES.taskUpdate, primary);
    case 'TaskStop':
      return playfulTarget(call, TOOL_PHRASES.taskStop, primary);
    case 'InvokeSkill':
      return playfulTarget(call, TOOL_PHRASES.invokeSkill, stringArg(args, 'skill') ?? primary);
    case 'ReadSkillResource':
      return playfulTarget(
        call,
        TOOL_PHRASES.readSkillResource,
        stringArg(args, 'path') ?? primary,
      );
    case 'ToolSearch':
      return playfulTarget(call, TOOL_PHRASES.toolSearch, stringArg(args, 'query') ?? primary);
    case 'AskUserQuestion':
      return pickPhrase(call, TOOL_PHRASES.askUserQuestion);
    case 'EnterPlanMode':
      return pickPhrase(call, TOOL_PHRASES.enterPlanMode);
    case 'ExitPlanMode':
      return pickPhrase(call, TOOL_PHRASES.exitPlanMode);
    case 'SessionHistorySearch':
      return playfulTarget(
        call,
        TOOL_PHRASES.sessionHistorySearch,
        stringArg(args, 'query') ?? primary,
      );
    case 'SessionHistoryRead':
      return pickPhrase(call, TOOL_PHRASES.sessionHistoryRead);
    case 'AgentPlan':
      return pickPhrase(call, TOOL_PHRASES.agentPlan);
    case 'AgentSpawn':
      return playfulTarget(
        call,
        TOOL_PHRASES.agentSpawn,
        stringArg(args, 'description', 'agent') ?? primary,
      );
    case 'AgentList':
      return pickPhrase(call, TOOL_PHRASES.agentList);
    case 'AgentGet':
      return playfulTarget(call, TOOL_PHRASES.agentGet, stringArg(args, 'agentId') ?? primary);
    case 'AgentRead':
      return playfulTarget(call, TOOL_PHRASES.agentRead, stringArg(args, 'agentId') ?? primary);
    case 'AgentSend':
      return playfulTarget(call, TOOL_PHRASES.agentSend, stringArg(args, 'message') ?? primary);
    case 'AgentWait':
      return playfulTarget(call, TOOL_PHRASES.agentWait, stringArg(args, 'agentId') ?? primary);
    case 'AgentStop':
      return playfulTarget(call, TOOL_PHRASES.agentStop, stringArg(args, 'agentId') ?? primary);
    case 'AgentApply':
      return pickPhrase(call, TOOL_PHRASES.agentApply);
    case 'EvidencePublish':
      // Deliberately no `?? primary` fallback, unlike its siblings: this call's
      // arguments carry no path or query, so `getPrimaryArg` falls through to
      // the first string key and hands back the `kind` enum. A row reading
      // `Filing evidence: blocker` names a category, not the finding; better to
      // drop the target and let the phrase stand alone.
      return playfulTarget(call, TOOL_PHRASES.evidencePublish, stringArg(args, 'summary'));
    case 'EvidenceList':
      return pickPhrase(call, TOOL_PHRASES.evidenceList);
    case 'EvidenceReview':
      return pickPhrase(call, TOOL_PHRASES.evidenceReview);
    default: {
      const toolName = humanizeToolName(canonicalName) || 'a tool';
      if (!primary) {
        return pickPhrase(call, [
          `Trying ${toolName}`,
          `Running ${toolName}`,
          `Giving ${toolName} a whirl`,
        ]);
      }
      return withTarget(
        pickPhrase(call, [
          `Trying ${toolName} on`,
          `Running ${toolName} on`,
          `Pointing ${toolName} at`,
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
  // The blocked labels stay plain on purpose: the run has stopped and is asking
  // the reader for something, which is the one moment a joke is in the way.
  if (pendingPlanApproval) {
    return { label: 'Waiting for plan approval', tone: 'waiting', blocked: true };
  }
  if (pendingUserQuestion) {
    return { label: 'Waiting for your answer', tone: 'waiting', blocked: true };
  }
  if (pendingPermission) {
    return { label: 'Waiting for permission', tone: 'waiting', blocked: true };
  }

  // The streaming message is at (or near) the end; scan backwards so this
  // per-render lookup stays O(1) on long transcripts.
  let activeMessage: Message | undefined;
  if (streamingMessageId) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].id === streamingMessageId) {
        activeMessage = messages[index];
        break;
      }
    }
  }
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
