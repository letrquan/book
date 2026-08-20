import { describe, expect, it } from 'vitest';
import type { ToolContext, UserQuestionRequest } from '../types/tools.js';
import {
  buildPlanApprovalQuestion,
  planApprovalFromUserQuestionResponse,
  planModeTools,
  planNotAppliedMessage,
  planStopDecision,
  READ_ONLY_PLAN_TOOLS,
} from './plan-mode.js';
import { parseUserQuestionInput, validateUserQuestionResponse } from './ask-user-question.js';

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
      'ApplyPatch',
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

describe('plan approval as a user question', () => {
  const question = (request: UserQuestionRequest) => request.questions[0].question;

  it('builds a request that satisfies the AskUserQuestion contract', () => {
    const request = buildPlanApprovalQuestion('Rename the module and update callers.', 'req-1');

    expect(request.id).toBe('req-1');
    expect(request.source).toEqual({ kind: 'root' });
    expect(question(request)).toContain('Rename the module and update callers.');
    expect(request.questions[0].options.map((option) => option.label)).toEqual([
      'Approve',
      'Reject',
    ]);
    expect(request.questions[0].multiSelect).toBe(false);
    // The host-built request must pass the same validation a model-built one does.
    expect(parseUserQuestionInput({ questions: request.questions })).not.toHaveProperty('error');
  });

  it('truncates a long plan so the question stays inside the 500-character limit', () => {
    const request = buildPlanApprovalQuestion('x'.repeat(5000), 'req-2');

    expect(question(request).length).toBeLessThanOrEqual(500);
    expect(question(request)).toContain('…');
    expect(parseUserQuestionInput({ questions: request.questions })).not.toHaveProperty('error');
  });

  it('maps the Approve answer to approve and the Reject answer to reject', () => {
    const request = buildPlanApprovalQuestion('Do it.', 'req-3');

    expect(
      planApprovalFromUserQuestionResponse(request, {
        action: 'answer',
        answers: { [question(request)]: 'Approve' },
      }),
    ).toBe('approve');
    expect(
      planApprovalFromUserQuestionResponse(request, {
        action: 'answer',
        answers: { [question(request)]: 'reject' },
      }),
    ).toBe('reject');
  });

  it('treats a free-text answer as revision feedback', () => {
    const request = buildPlanApprovalQuestion('Do it.', 'req-4');

    expect(
      planApprovalFromUserQuestionResponse(request, {
        action: 'answer',
        answers: { [question(request)]: '  Keep the migration backward compatible.  ' },
      }),
    ).toEqual({ decision: 'revise', feedback: 'Keep the migration backward compatible.' });
  });

  it('stops instead of looping when the host declines or cancels', () => {
    const request = buildPlanApprovalQuestion('Do it.', 'req-5');

    expect(
      planApprovalFromUserQuestionResponse(request, { action: 'decline', message: 'no approver' }),
    ).toEqual({
      decision: 'stop',
      reason: 'approval_declined',
      message: planNotAppliedMessage('approval_declined', 'no approver'),
    });
    expect(planApprovalFromUserQuestionResponse(request, { action: 'cancel' })).toEqual({
      decision: 'stop',
      reason: 'approval_cancelled',
      message: planNotAppliedMessage('approval_cancelled'),
    });
  });

  it('stops on a response that violates the user-question contract', () => {
    const request = buildPlanApprovalQuestion('Do it.', 'req-6');
    const response = { action: 'answer' as const, answers: { 'Some other question?': 'Approve' } };
    // Same rejection the AskUserQuestion path would produce.
    expect(validateUserQuestionResponse(request, response)).not.toBeNull();

    const decision = planApprovalFromUserQuestionResponse(request, response);

    expect(decision).toMatchObject({ decision: 'stop', reason: 'invalid_approval_response' });
  });

  it('explains that nothing was applied for every stop reason', () => {
    for (const reason of [
      'approval_unavailable',
      'approval_declined',
      'approval_cancelled',
      'invalid_approval_response',
    ] as const) {
      expect(planStopDecision(reason)).toEqual({
        decision: 'stop',
        reason,
        message: expect.stringContaining('No changes were applied'),
      });
    }
    expect(planNotAppliedMessage('approval_unavailable')).toContain('non-interactive host');
  });
});
