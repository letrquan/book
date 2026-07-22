import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types/tools.js';
import { planModeTools, READ_ONLY_PLAN_TOOLS } from './plan-mode.js';

function tool(name: string) {
  const found = planModeTools.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { workspaceRoot: '/tmp/book', env: {}, ...overrides };
}

describe('plan mode tools', () => {
  it('EnterPlanMode sets currentMode to plan and preserves previousMode', async () => {
    const context = ctx({ currentMode: 'default' });

    const result = await tool('EnterPlanMode').execute({}, context);

    expect(result.status).toBe('success');
    expect(context.currentMode).toBe('plan');
    expect(context.previousMode).toBe('default');
  });

  it('EnterPlanMode is idempotent when already in plan mode', async () => {
    const context = ctx({ currentMode: 'plan', previousMode: 'accept-edits' });

    const result = await tool('EnterPlanMode').execute({}, context);

    expect(result.status).toBe('success');
    expect(context.currentMode).toBe('plan');
    expect(context.previousMode).toBe('accept-edits');
  });

  it('ExitPlanMode requires a non-empty plan string', async () => {
    const context = ctx({ currentMode: 'plan' });

    const result = await tool('ExitPlanMode').execute({ plan: '   ' }, context);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/plan must be/);
    expect(context.pendingPlanApproval).toBeUndefined();
  });

  it('ExitPlanMode stores the plan for host approval without restoring mode', async () => {
    const context = ctx({ currentMode: 'plan', previousMode: 'default' });

    const result = await tool('ExitPlanMode').execute({ plan: 'Do the thing.' }, context);

    expect(result.status).toBe('success');
    expect(context.currentMode).toBe('plan');
    expect(context.previousMode).toBe('default');
    expect(context.pendingPlanApproval).toEqual({ plan: 'Do the thing.' });
  });

  it('classifies expected read-only and mutating tools for plan mode', () => {
    for (const name of [
      'Read',
      'Glob',
      'Grep',
      'GitStatus',
      'GitDiff',
      'WebFetch',
      'EnterPlanMode',
      'ExitPlanMode',
    ]) {
      expect(READ_ONLY_PLAN_TOOLS.has(name), `expected ${name} read-only`).toBe(true);
    }

    for (const name of [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'GitCommit',
      'InvokeSkill',
      'Task',
    ]) {
      expect(READ_ONLY_PLAN_TOOLS.has(name), `expected ${name} blocked`).toBe(false);
    }
  });
});
