import { describe, expect, it, vi } from 'vitest';
import type { ToolCall, UserQuestionRequest } from '../types.js';
import { AgentInteractionController } from './agent-interactions.js';

const toolCall: ToolCall = { id: 'tc-1', name: 'Bash', arguments: { command: 'ls' } };

function question(id: string): UserQuestionRequest {
  return {
    id,
    source: { kind: 'root' },
    questions: [
      {
        question: `Question ${id}?`,
        header: 'Question',
        options: [
          { label: 'Yes', description: 'Yes' },
          { label: 'No', description: 'No' },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe('AgentInteractionController', () => {
  it('publishes resolver-free snapshots and settles permission exactly once', async () => {
    const controller = new AgentInteractionController();
    const listener = vi.fn();
    controller.subscribe(listener);

    const result = controller.requestPermission(toolCall);
    expect(controller.getSnapshot()).toEqual({
      pendingPermission: { toolCall },
      pendingPlanApproval: null,
      pendingUserQuestions: [],
    });
    expect(controller.getSnapshot().pendingPermission).not.toHaveProperty('resolve');

    expect(controller.settlePermission('allow', 'resolve')).toBe(true);
    expect(controller.settlePermission('deny', 'cancel')).toBe(false);
    await expect(result).resolves.toBe('allow');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects a superseded plan request instead of leaving its promise pending', async () => {
    const controller = new AgentInteractionController();
    const first = controller.requestPlanApproval('first');
    const second = controller.requestPlanApproval('second');

    await expect(first).resolves.toBe('reject');
    expect(controller.getSnapshot().pendingPlanApproval).toEqual({ plan: 'second' });
    expect(controller.settlePlanApproval('approve', 'resolve')).toBe(true);
    expect(controller.settlePlanApproval('reject', 'unmount')).toBe(false);
    await expect(second).resolves.toBe('approve');
  });

  it('settles queued user questions by id or FIFO and cancels the remainder', async () => {
    const controller = new AgentInteractionController();
    const first = controller.requestUserQuestion(question('one'));
    const second = controller.requestUserQuestion(question('two'));

    expect(
      controller.settleUserQuestion(
        { action: 'answer', answers: { 'Question two?': 'Yes' } },
        'resolve',
        'two',
      ),
    ).toBe(true);
    await expect(second).resolves.toEqual({
      action: 'answer',
      answers: { 'Question two?': 'Yes' },
    });
    expect(controller.getSnapshot().pendingUserQuestions.map((entry) => entry.request.id)).toEqual([
      'one',
    ]);

    expect(controller.cancelUserQuestions('clear')).toBe(1);
    await expect(first).resolves.toEqual({
      action: 'cancel',
      message: 'Question cancelled via clear.',
    });
    expect(controller.cancelUserQuestions('clear')).toBe(0);
  });

  it('settles every interaction during cleanup without double resolution', async () => {
    const controller = new AgentInteractionController();
    const permission = controller.requestPermission(toolCall);
    const plan = controller.requestPlanApproval('do the thing');
    const userQuestion = controller.requestUserQuestion(question('one'));

    expect(controller.cancelAll('unmount')).toEqual({
      permission: true,
      planApproval: true,
      userQuestions: 1,
    });
    expect(controller.cancelAll('unmount')).toEqual({
      permission: false,
      planApproval: false,
      userQuestions: 0,
    });
    await expect(permission).resolves.toBe('deny');
    await expect(plan).resolves.toBe('reject');
    await expect(userQuestion).resolves.toMatchObject({ action: 'cancel' });
  });
});
