import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-events.js';
import { createAgentSessionSnapshot, reduceAgentSessionSnapshot } from './agent-events.js';
import { toolSuccess } from '../tools/result.js';

function reduce(events: AgentEvent[]) {
  return events.reduce(reduceAgentSessionSnapshot, createAgentSessionSnapshot());
}

describe('agent session event reducer', () => {
  it('builds a completed snapshot from a streamed run', () => {
    const toolCall = { id: 'call-1', name: 'Read', arguments: { file_path: 'README.md' } };
    const toolResult = toolSuccess('contents', { toolCallId: toolCall.id });
    const snapshot = reduce([
      { type: 'system', model: 'model-x', cwd: '/workspace' },
      { type: 'session', sessionId: 'session-1' },
      { type: 'text', content: 'Hello ' },
      { type: 'text', content: 'world' },
      { type: 'tool_use', toolCall },
      { type: 'tool_result', toolResult },
      { type: 'result', messages: [], usage: null, sessionId: 'session-1' },
      {
        type: 'terminal',
        outcome: { status: 'completed', reason: 'normal_completion', partialOutput: false },
      },
      { type: 'done' },
    ]);

    expect(snapshot).toMatchObject({
      status: 'completed',
      sessionId: 'session-1',
      model: 'model-x',
      cwd: '/workspace',
      assistantText: 'Hello world',
      toolCalls: [toolCall],
      toolResults: [toolResult],
    });
  });

  it('tracks and settles a pending user question immutably', () => {
    const initial = createAgentSessionSnapshot();
    const request = {
      id: 'question-1',
      questions: [{ question: 'Continue?', header: 'Choice', options: [], multiSelect: false }],
      source: { kind: 'root' as const },
    };
    const pending = reduceAgentSessionSnapshot(initial, {
      type: 'user_question',
      request,
      status: 'pending',
    });
    const settled = reduceAgentSessionSnapshot(pending, {
      type: 'user_question_result',
      requestId: request.id,
      response: { action: 'answer', answers: { Choice: 'yes' } },
    });

    expect(initial.status).toBe('idle');
    expect(pending).toMatchObject({ status: 'waiting_for_user', pendingUserQuestion: request });
    expect(settled.status).toBe('running');
    expect(settled.pendingUserQuestion).toBeUndefined();
  });

  it('keeps failures terminal when done is emitted during cleanup', () => {
    const snapshot = reduce([
      { type: 'system', model: 'model-x', cwd: '/workspace' },
      { type: 'error', error: 'provider failed' },
      {
        type: 'terminal',
        outcome: {
          status: 'failed',
          reason: 'provider_error',
          message: 'provider failed',
          partialOutput: false,
        },
      },
      { type: 'done' },
    ]);

    expect(snapshot).toMatchObject({ status: 'failed', error: 'provider failed' });
  });

  it.each([
    ['failed', 'provider_error'],
    ['cancelled', 'user_cancelled'],
    ['timed_out', 'stream_stall'],
    ['interrupted', 'transport_interrupted'],
  ] as const)('does not overwrite a %s terminal state with later events', (status, reason) => {
    const outcome = { status, reason, partialOutput: true };
    const snapshot = reduce([
      { type: 'system', model: 'model-x', cwd: '/workspace' },
      { type: 'text', content: 'partial' },
      { type: 'terminal', outcome },
      { type: 'result', messages: [], usage: null, sessionId: 'late-session' },
      { type: 'text', content: ' ignored' },
      { type: 'done' },
    ]);

    expect(snapshot).toMatchObject({
      status,
      assistantText: 'partial',
      terminal: outcome,
      messages: [],
    });
    expect(snapshot).not.toHaveProperty('sessionId');
  });

  it('treats done without a terminal event as an interrupted run', () => {
    const snapshot = reduce([
      { type: 'system', model: 'model-x', cwd: '/workspace' },
      { type: 'text', content: 'partial' },
      { type: 'done' },
    ]);

    expect(snapshot).toMatchObject({
      status: 'interrupted',
      assistantText: 'partial',
      terminal: {
        status: 'interrupted',
        reason: 'missing_terminal',
        partialOutput: true,
      },
    });
  });
});
