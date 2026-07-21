import type {
  AgentTask,
  AgentTaskStatus,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types.js';
import { toolFailure, toolSuccess } from './result.js';

const ACTIVE_STATUSES = new Set<AgentTaskStatus>(['pending', 'in_progress', 'completed']);
const ALL_STATUSES = new Set<AgentTaskStatus>(['pending', 'in_progress', 'completed', 'deleted']);

function fail(error: string): ToolResult {
  return toolFailure(error);
}

function ok(output: string): ToolResult {
  return toolSuccess(output);
}

function tasks(ctx: ToolContext): AgentTask[] {
  ctx.tasks ??= ctx.agentConfig?.tasks ?? [];
  if (ctx.agentConfig && ctx.agentConfig.tasks !== ctx.tasks) {
    ctx.agentConfig.tasks = ctx.tasks;
  }
  return ctx.tasks;
}

function activeTasks(ctx: ToolContext): AgentTask[] {
  return tasks(ctx).filter((task) => task.status !== 'deleted');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function readStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readMetadata(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function readTaskId(args: Record<string, unknown>): string | undefined {
  return (readString(args, 'taskId') ?? readString(args, 'task_id'))?.trim();
}

function findTask(ctx: ToolContext, taskId: string): AgentTask | undefined {
  return tasks(ctx).find((task) => task.id === taskId && task.status !== 'deleted');
}

function discardCreatedTask(ctx: ToolContext, task: AgentTask): void {
  const all = tasks(ctx);
  const index = all.indexOf(task);
  if (index !== -1) all.splice(index, 1);
  for (const candidate of all) {
    candidate.blockedBy = candidate.blockedBy.filter((id) => id !== task.id);
    candidate.blocks = candidate.blocks.filter((id) => id !== task.id);
  }
}

function openBlockers(
  ctx: ToolContext,
  task: AgentTask,
  additionalBlockedBy: string[] = [],
): AgentTask[] {
  return unique([...task.blockedBy, ...additionalBlockedBy])
    .map((id) => tasks(ctx).find((candidate) => candidate.id === id))
    .filter(
      (candidate): candidate is AgentTask =>
        candidate !== undefined &&
        candidate.status !== 'completed' &&
        candidate.status !== 'deleted',
    );
}

function clearResolvedDependencies(ctx: ToolContext): void {
  const all = tasks(ctx);
  const resolved = new Set(
    all
      .filter((task) => task.status === 'completed' || task.status === 'deleted')
      .map((task) => task.id),
  );
  if (resolved.size === 0) return;

  for (const task of all) {
    task.blockedBy = task.blockedBy.filter((id) => !resolved.has(id));
  }
}

function nextTaskId(existing: AgentTask[]): string {
  let max = 0;
  for (const task of existing) {
    const n = Number(task.id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

function ensureSingleInProgress(ctx: ToolContext, taskId: string): string | undefined {
  const other = activeTasks(ctx).find(
    (task) => task.id !== taskId && task.status === 'in_progress',
  );
  if (!other) return undefined;
  return `Only one task may be in_progress at a time (task #${other.id} is already in_progress).`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function addLinks(
  ctx: ToolContext,
  task: AgentTask,
  addBlockedBy: string[],
  addBlocks: string[],
): void {
  const all = tasks(ctx);
  const blockedBy = unique(addBlockedBy.filter((id) => id !== task.id));
  const blocks = unique(addBlocks.filter((id) => id !== task.id));

  task.blockedBy = unique([...task.blockedBy, ...blockedBy]);
  task.blocks = unique([...task.blocks, ...blocks]);

  for (const id of blockedBy) {
    const dependency = all.find(
      (candidate) => candidate.id === id && candidate.status !== 'deleted',
    );
    if (dependency) dependency.blocks = unique([...dependency.blocks, task.id]);
  }

  for (const id of blocks) {
    const blocked = all.find((candidate) => candidate.id === id && candidate.status !== 'deleted');
    if (blocked) blocked.blockedBy = unique([...blocked.blockedBy, task.id]);
  }
}

function formatTask(task: AgentTask): string {
  const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '→' : '○';
  const owner = task.owner ? ` owner=${task.owner}` : '';
  const blockedBy = task.blockedBy.length ? ` blockedBy=[${task.blockedBy.join(', ')}]` : '';
  return `${mark} #${task.id} ${task.subject} (${task.status}${owner}${blockedBy})`;
}

function formatTaskDetails(task: AgentTask): string {
  const lines = [
    `Task #${task.id}: ${task.subject}`,
    `status: ${task.status}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    ...(task.activeForm ? [`activeForm: ${task.activeForm}`] : []),
    ...(task.owner ? [`owner: ${task.owner}`] : []),
    `blockedBy: ${task.blockedBy.length ? task.blockedBy.join(', ') : '(none)'}`,
    `blocks: ${task.blocks.length ? task.blocks.join(', ') : '(none)'}`,
  ];
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    lines.push(`metadata: ${JSON.stringify(task.metadata)}`);
  }
  return lines.join('\n');
}

async function taskCreate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const subject = readString(args, 'subject')?.trim();
  if (!subject) return fail('subject must be a non-empty string');

  const statusValue = readString(args, 'status') ?? 'pending';
  if (!ACTIVE_STATUSES.has(statusValue as AgentTaskStatus)) {
    return fail('status must be pending, in_progress, or completed');
  }
  const status = statusValue as AgentTaskStatus;

  const list = tasks(ctx);
  const id = nextTaskId(list);
  const addBlockedBy = readStringArray(args, 'addBlockedBy');
  const addBlocks = readStringArray(args, 'addBlocks');

  const now = Date.now();
  const task: AgentTask = {
    id,
    subject,
    description: readString(args, 'description'),
    status,
    activeForm: readString(args, 'activeForm'),
    owner: readString(args, 'owner'),
    metadata: readMetadata(args.metadata),
    blockedBy: [],
    blocks: [],
    createdAt: now,
    updatedAt: now,
  };

  list.push(task);
  addLinks(ctx, task, addBlockedBy, addBlocks);
  clearResolvedDependencies(ctx);
  if (status === 'in_progress') {
    const blockers = openBlockers(ctx, task, addBlockedBy);
    if (blockers.length > 0) {
      discardCreatedTask(ctx, task);
      return fail(
        `Task #${task.id} is blocked by #${blockers.map((blocker) => blocker.id).join(', #')}`,
      );
    }
    const conflict = ensureSingleInProgress(ctx, id);
    if (conflict) {
      discardCreatedTask(ctx, task);
      return fail(conflict);
    }
  }

  return ok(`Created task #${task.id}.\n${formatTask(task)}`);
}

async function taskList(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const visible = activeTasks(ctx);
  if (visible.length === 0) return ok('No tasks.');

  const counts = visible.reduce(
    (acc, task) => {
      if (task.status !== 'deleted') acc[task.status]++;
      return acc;
    },
    { pending: 0, in_progress: 0, completed: 0 } satisfies Record<
      Exclude<AgentTaskStatus, 'deleted'>,
      number
    >,
  );

  return ok(
    [
      `Tasks (${visible.length}; pending ${counts.pending}, in_progress ${counts.in_progress}, completed ${counts.completed}):`,
      ...visible.map(formatTask),
    ].join('\n'),
  );
}

async function taskGet(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const taskId = readTaskId(args);
  if (!taskId) return fail('taskId must be a non-empty string');

  const task = findTask(ctx, taskId);
  if (!task) return fail(`Task #${taskId} not found`);

  return ok(formatTaskDetails(task));
}

async function taskUpdate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const taskId = readTaskId(args);
  if (!taskId) return fail('taskId must be a non-empty string');

  const task = findTask(ctx, taskId);
  if (!task) return fail(`Task #${taskId} not found`);

  const addBlockedBy = readStringArray(args, 'addBlockedBy');
  const addBlocks = readStringArray(args, 'addBlocks');
  const statusValue = readString(args, 'status');
  let nextStatus = task.status;
  if (statusValue !== undefined) {
    if (!ALL_STATUSES.has(statusValue as AgentTaskStatus)) {
      return fail('status must be pending, in_progress, completed, or deleted');
    }
    nextStatus = statusValue as AgentTaskStatus;
  }

  if (nextStatus === 'in_progress') {
    clearResolvedDependencies(ctx);
    const blockers = openBlockers(ctx, task, addBlockedBy);
    if (blockers.length > 0) {
      return fail(
        `Task #${task.id} is blocked by #${blockers.map((blocker) => blocker.id).join(', #')}`,
      );
    }
    const conflict = ensureSingleInProgress(ctx, task.id);
    if (conflict) return fail(conflict);
  }

  if (statusValue !== undefined) {
    task.status = nextStatus;
  }

  const subject = readString(args, 'subject')?.trim();
  if (subject !== undefined) {
    if (!subject) return fail('subject must be a non-empty string');
    task.subject = subject;
  }

  if (typeof args.description === 'string') task.description = args.description;
  if (typeof args.activeForm === 'string') task.activeForm = args.activeForm;
  if (typeof args.owner === 'string') task.owner = args.owner;

  if (isRecord(args.metadata)) {
    task.metadata ??= {};
    for (const [key, value] of Object.entries(args.metadata)) {
      if (value === null) {
        delete task.metadata[key];
      } else {
        task.metadata[key] = value;
      }
    }
    if (Object.keys(task.metadata).length === 0) delete task.metadata;
  }

  addLinks(ctx, task, addBlockedBy, addBlocks);
  clearResolvedDependencies(ctx);
  task.updatedAt = Date.now();

  return ok(`Updated task #${task.id}.\n${formatTask(task)}`);
}

async function taskStop(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const taskId = readTaskId(args);
  if (!taskId) return fail('taskId must be a non-empty string');

  const task = findTask(ctx, taskId);
  if (!task) return fail(`Task #${taskId} not found`);

  if (task.status === 'in_progress') {
    task.status = 'pending';
    task.updatedAt = Date.now();
    return ok(`Stopped task #${task.id}; status reset to pending.`);
  }

  return ok(`Task #${task.id} is ${task.status}; no running task was stopped.`);
}

export const taskTools: ToolDefinition[] = [
  {
    name: 'TaskCreate',
    description:
      'Create an agent task with status, dependencies, metadata, and optional activeForm. Use this instead of TodoWrite for tracking multi-step work.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed task description' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Initial task status',
        },
        activeForm: {
          type: 'string',
          description: 'Present-continuous form shown while in progress',
        },
        owner: { type: 'string', description: 'Optional owner/agent identifier' },
        metadata: {
          type: 'object',
          description: 'Arbitrary task metadata',
          additionalProperties: true,
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task',
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs this task blocks',
        },
      },
      required: ['subject'],
    },
    execute: taskCreate,
  },
  {
    name: 'TaskList',
    description: 'List all non-deleted agent tasks with status and dependency summaries.',
    parameters: { type: 'object', properties: {} },
    execute: taskList,
  },
  {
    name: 'TaskGet',
    description: 'Get full details for one agent task by ID.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID to retrieve' } },
      required: ['taskId'],
    },
    execute: taskGet,
  },
  {
    name: 'TaskUpdate',
    description:
      'Update an agent task status, fields, metadata, and dependencies. Use status "deleted" to remove a task from active listings.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to update' },
        subject: { type: 'string', description: 'New short task title' },
        description: { type: 'string', description: 'New detailed task description' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'deleted'],
          description: 'New task status',
        },
        activeForm: {
          type: 'string',
          description: 'Present-continuous form shown while in progress',
        },
        owner: { type: 'string', description: 'Optional owner/agent identifier' },
        metadata: {
          type: 'object',
          description: 'Metadata to merge; null values remove keys',
          additionalProperties: true,
        },
        addBlockedBy: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs that block this task',
        },
        addBlocks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task IDs this task blocks',
        },
      },
      required: ['taskId'],
    },
    execute: taskUpdate,
  },
  {
    name: 'TaskStop',
    description:
      'Stop a tool-managed agent task by ID. This resets in_progress tasks to pending; background process stopping will be wired after BashOutput/KillShell and background agents exist.',
    parameters: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID to stop' } },
      required: ['taskId'],
    },
    execute: taskStop,
  },
];
