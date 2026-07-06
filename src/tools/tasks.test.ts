import { describe, it, expect } from 'vitest';
import { taskTools } from './tasks.js';
import { defaultConfig } from '../test/fixtures.js';
import type { ToolContext } from '../types.js';

function ctx(): ToolContext {
  return { workspaceRoot: '.', env: {} };
}

function tool(name: string) {
  const found = taskTools.find((t) => t.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

const taskCreate = tool('TaskCreate');
const taskList = tool('TaskList');
const taskGet = tool('TaskGet');
const taskUpdate = tool('TaskUpdate');
const taskStop = tool('TaskStop');

describe('task management tools', () => {
  it('creates a task and stores it in context', async () => {
    const c = ctx();
    const r = await taskCreate.execute({ subject: 'Read files', description: 'Inspect source' }, c);

    expect(r.success).toBe(true);
    expect(r.output).toMatch(/Created task #1/);
    expect(c.tasks).toHaveLength(1);
    expect(c.tasks?.[0]).toMatchObject({
      id: '1',
      subject: 'Read files',
      description: 'Inspect source',
      status: 'pending',
      blockedBy: [],
      blocks: [],
    });
  });

  it('shares task state through AgentConfig across contexts', async () => {
    const agentConfig = defaultConfig();
    const first: ToolContext = { workspaceRoot: '.', env: {}, agentConfig };
    const second: ToolContext = { workspaceRoot: '.', env: {}, agentConfig };

    await taskCreate.execute({ subject: 'Persisted task' }, first);
    const listed = await taskList.execute({}, second);

    expect(listed.success).toBe(true);
    expect(listed.output).toContain('#1 Persisted task');
    expect(agentConfig.tasks).toHaveLength(1);
  });

  it('rejects an empty subject', async () => {
    const r = await taskCreate.execute({ subject: '   ' }, ctx());

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/subject/i);
  });

  it('allows only one in_progress task', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'A', status: 'in_progress' }, c);
    const r = await taskCreate.execute({ subject: 'B', status: 'in_progress' }, c);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/only one task may be in_progress/i);
  });

  it('lists active tasks and filters deleted tasks', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'A' }, c);
    await taskCreate.execute({ subject: 'B', status: 'completed' }, c);
    await taskUpdate.execute({ taskId: '1', status: 'deleted' }, c);

    const r = await taskList.execute({}, c);

    expect(r.success).toBe(true);
    expect(r.output).not.toMatch(/#1 A/);
    expect(r.output).toMatch(/#2 B/);
    expect(r.output).toMatch(/completed 1/);
  });

  it('gets full task details and errors for missing IDs', async () => {
    const c = ctx();
    await taskCreate.execute(
      { subject: 'A', description: 'Details', metadata: { priority: 'high' } },
      c,
    );

    const found = await taskGet.execute({ task_id: '1' }, c);
    const missing = await taskGet.execute({ taskId: '2' }, c);

    expect(found.success).toBe(true);
    expect(found.output).toMatch(/Task #1: A/);
    expect(found.output).toMatch(/metadata: {"priority":"high"}/);
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/not found/i);
  });

  it('updates fields, metadata, dependencies, and reciprocal links', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'Dependency' }, c);
    await taskCreate.execute({ subject: 'Blocked' }, c);

    const r = await taskUpdate.execute(
      {
        taskId: '2',
        subject: 'Blocked task',
        activeForm: 'Doing blocked task',
        metadata: { priority: 'high', removeMe: 'x' },
        addBlockedBy: ['1', '1'],
      },
      c,
    );
    const remove = await taskUpdate.execute({ taskId: '2', metadata: { removeMe: null } }, c);

    expect(r.success).toBe(true);
    expect(remove.success).toBe(true);
    expect(c.tasks?.[1]).toMatchObject({
      subject: 'Blocked task',
      status: 'pending',
      activeForm: 'Doing blocked task',
      metadata: { priority: 'high' },
      blockedBy: ['1'],
    });
    expect(c.tasks?.[0].blocks).toEqual(['2']);
  });

  it('rejects setting a second task to in_progress', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'A', status: 'in_progress' }, c);
    await taskCreate.execute({ subject: 'B' }, c);

    const r = await taskUpdate.execute({ taskId: '2', status: 'in_progress' }, c);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already in_progress/i);
  });

  it('rejects setting a blocked task to in_progress', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'Dependency' }, c);
    await taskCreate.execute({ subject: 'Blocked', addBlockedBy: ['1'] }, c);

    const r = await taskUpdate.execute({ taskId: '2', status: 'in_progress' }, c);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/blocked by #1/i);
    expect(c.tasks?.[1].status).toBe('pending');
  });

  it('does not create an in_progress task when requested blockers are open', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'Dependency' }, c);

    const r = await taskCreate.execute(
      { subject: 'Blocked active task', status: 'in_progress', addBlockedBy: ['1'] },
      c,
    );

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/blocked by #1/i);
    expect(c.tasks).toHaveLength(1);
  });

  it('does not add new blockers to an in_progress task', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'Dependency' }, c);
    await taskCreate.execute({ subject: 'Active', status: 'in_progress' }, c);

    const r = await taskUpdate.execute({ taskId: '2', addBlockedBy: ['1'] }, c);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/blocked by #1/i);
    expect(c.tasks?.[1].blockedBy).toEqual([]);
  });

  it('unblocks dependents when blockers complete or are deleted', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'Dependency' }, c);
    await taskCreate.execute({ subject: 'Blocked', addBlockedBy: ['1'] }, c);

    await taskUpdate.execute({ taskId: '1', status: 'completed' }, c);
    const r = await taskUpdate.execute({ taskId: '2', status: 'in_progress' }, c);

    expect(r.success).toBe(true);
    expect(c.tasks?.[1].blockedBy).toEqual([]);
    expect(c.tasks?.[1].status).toBe('in_progress');
  });

  it('soft-deletes tasks and hides them from get', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'A' }, c);

    const deleted = await taskUpdate.execute({ taskId: '1', status: 'deleted' }, c);
    const found = await taskGet.execute({ taskId: '1' }, c);

    expect(deleted.success).toBe(true);
    expect(c.tasks?.[0].status).toBe('deleted');
    expect(found.success).toBe(false);
  });

  it('stops an in_progress task by returning it to pending', async () => {
    const c = ctx();
    await taskCreate.execute({ subject: 'A', status: 'in_progress' }, c);

    const r = await taskStop.execute({ taskId: '1' }, c);

    expect(r.success).toBe(true);
    expect(r.output).toMatch(/reset to pending/i);
    expect(c.tasks?.[0].status).toBe('pending');
  });

  it('errors when stopping a missing task', async () => {
    const r = await taskStop.execute({ taskId: 'missing' }, ctx());

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });
});
