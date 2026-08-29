import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';
import type { UserQuestionRequest, UserQuestionResponse } from './types/tools.js';

const PLAN = 'Step 1: rename the module.\nStep 2: update every caller.';

let tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const workspace = mkdtempSync(join(tmpdir(), 'book-headless-plan-'));
  tempDirs.push(workspace);
  return defaultConfig({ baseUrl: 'http://localhost/v1', workspace, ...overrides });
}

function toolCallEvent(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
}

function textEvent(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}

/** Always submits the same plan; a host that keeps rejecting would loop here forever. */
function stubExitPlanModeProvider(): { fetch: typeof fetch; calls: () => number } {
  const provider = createRepeatingScriptedProvider(() =>
    sseResponse([toolCallEvent('exit-1', 'ExitPlanMode', { plan: PLAN })]),
  );
  vi.stubGlobal('fetch', provider.fetch);
  return { fetch: provider.fetch, calls: () => provider.requests.length };
}

/** ExitPlanMode on the first turn, then plain text once the plan is approved. */
function stubPlanThenTextProvider(text: string): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls++;
      return calls === 1
        ? sseResponse([toolCallEvent('exit-1', 'ExitPlanMode', { plan: PLAN })])
        : sseResponse([textEvent(text)]);
    }),
  );
  return { calls: () => calls };
}

function collectWrites(): { stdout: { write: (value: string) => boolean }; text: () => string } {
  const writes: string[] = [];
  return {
    stdout: {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    },
    text: () => writes.join(''),
  };
}

function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runHeadless — plan mode without an approver', () => {
  it('stops at the first plan and prints it instead of burning the turn budget', async () => {
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      stdout: out.stdout,
    });

    // One provider round-trip: no ExitPlanMode retry loop.
    expect(provider.calls()).toBe(1);
    expect(result.plan).toEqual({
      status: 'not_applied',
      reason: 'approval_unavailable',
      plan: PLAN,
      message: expect.stringContaining('No changes were applied'),
    });
    expect(out.text()).toContain(PLAN);
    expect(out.text()).toContain('non-interactive host');
    expect(out.text()).not.toContain('SKIPPED');
    // "completed successfully but took no action": the CLI still exits 0 on a
    // completed outcome, and `plan.status` carries the not-applied fact. The
    // reason is `plan_stop` rather than `normal_completion` so a supervisor can
    // distinguish this from a finished objective without parsing the payload.
    expect(result.outcome).toMatchObject({
      status: 'completed',
      reason: 'plan_stop',
      partialOutput: false,
    });
  });

  it('reports the not-applied plan in the json result payload', async () => {
    stubExitPlanModeProvider();
    const out = collectWrites();

    await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      stdout: out.stdout,
    });

    const payload = JSON.parse(out.text().trim()) as {
      result: {
        plan?: { status: string; reason: string; plan: string };
        outcome: { status: string; reason: string };
      };
    };
    expect(payload.result.plan).toMatchObject({
      status: 'not_applied',
      reason: 'approval_unavailable',
      plan: PLAN,
    });
    expect(payload.result.outcome).toMatchObject({
      status: 'completed',
      reason: 'plan_stop',
    });
  });

  it('emits a stop plan_approval event and never leaves plan mode in stream-json', async () => {
    stubExitPlanModeProvider();
    const out = collectWrites();

    await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      stdout: out.stdout,
    });

    const events = parseEvents(out.text());
    expect(events).toContainEqual({ type: 'plan_approval', status: 'stop' });
    // Fail-closed: the mode is never restored, so nothing could have mutated.
    expect(events.filter((event) => event.type === 'mode_change')).toEqual([]);
    const final = events.find((event) => event.type === 'result') as
      { result: { plan?: { status: string; plan: string } } } | undefined;
    expect(final?.result.plan).toMatchObject({ status: 'not_applied', plan: PLAN });
  });

  it('does not consume queued stream-json prompts after an unapprovable plan', async () => {
    const { Readable } = await import('stream');
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'plan the refactor' }) + '\n',
      JSON.stringify({ type: 'user', content: 'now do something else' }) + '\n',
    ]);

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'json',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      stdout: out.stdout,
      stdin,
    });

    expect(provider.calls()).toBe(1);
    expect(result.plan?.reason).toBe('approval_unavailable');
    expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  });

  it('keeps auto-approving plans in bypassPermissions mode', async () => {
    const provider = stubPlanThenTextProvider('Refactor applied.');
    const out = collectWrites();

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 5,
      stdout: out.stdout,
    });

    expect(provider.calls()).toBe(2);
    expect(result.plan).toBeUndefined();
    expect(out.text()).toContain('Refactor applied.');
  });
});

describe('runHeadless — plan approval through the user-question handler', () => {
  it('approves the plan when the host answers Approve', async () => {
    const provider = stubPlanThenTextProvider('Refactor applied.');
    const out = collectWrites();
    const seen: UserQuestionRequest[] = [];
    const handler = vi.fn(async (request: UserQuestionRequest): Promise<UserQuestionResponse> => {
      seen.push(request);
      return { action: 'answer', answers: { [request.questions[0].question]: 'Approve' } };
    });

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    expect(handler).toHaveBeenCalledOnce();
    // The host can see what it is approving, inside the AskUserQuestion contract.
    expect(seen[0].questions[0].question).toContain('Step 1: rename the module.');
    expect(seen[0].questions[0].options.map((option) => option.label)).toEqual([
      'Approve',
      'Reject',
    ]);
    expect(provider.calls()).toBe(2);
    expect(result.plan).toBeUndefined();

    const events = parseEvents(out.text());
    expect(events).toContainEqual({ type: 'plan_approval', status: 'approve' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_question', status: 'pending' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user_question_result',
        response: expect.objectContaining({ action: 'answer' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'mode_change', mode: 'default' }),
    );
  });

  it('lets the host reject and keep the agent planning', async () => {
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();
    const handler = vi.fn(async (request: UserQuestionRequest): Promise<UserQuestionResponse> => ({
      action: 'answer',
      answers: { [request.questions[0].question]: 'Reject' },
    }));

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'plan',
      maxTurns: 2,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    // A real approver stays in charge: reject means "revise", not "stop".
    expect(provider.calls()).toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.plan).toBeUndefined();
  });

  it('returns a free-text answer to the agent as revision feedback', async () => {
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();
    const handler = vi.fn(async (request: UserQuestionRequest): Promise<UserQuestionResponse> => ({
      action: 'answer',
      answers: { [request.questions[0].question]: 'Keep the migration backward compatible.' },
    }));

    await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'plan',
      maxTurns: 1,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    expect(provider.calls()).toBe(1);
    const events = parseEvents(out.text());
    expect(events).toContainEqual({ type: 'plan_approval', status: 'revise' });
    const toolResult = events.find((event) => event.type === 'tool_result') as
      { tool_result: { structuredError?: { message?: string } } } | undefined;
    expect(toolResult?.tool_result.structuredError?.message).toContain(
      'Keep the migration backward compatible.',
    );
  });

  it('stops without changes when the host declines to decide', async () => {
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();
    const handler = vi.fn(async (): Promise<UserQuestionResponse> => ({
      action: 'decline',
      message: 'not my call',
    }));

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    expect(provider.calls()).toBe(1);
    expect(result.plan).toMatchObject({ status: 'not_applied', reason: 'approval_declined' });
    expect(out.text()).toContain(PLAN);
    expect(result.outcome.status).toBe('completed');
  });

  it('stops without changes when the approval handler throws', async () => {
    const provider = stubExitPlanModeProvider();
    const out = collectWrites();
    const handler = vi.fn(async (): Promise<UserQuestionResponse> => {
      throw new Error('handler exploded');
    });

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'plan',
      maxTurns: 5,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    expect(provider.calls()).toBe(1);
    expect(result.plan).toMatchObject({
      status: 'not_applied',
      reason: 'approval_cancelled',
      message: expect.stringContaining('handler exploded'),
    });
  });

  it('never asks the handler in bypassPermissions mode', async () => {
    const provider = stubPlanThenTextProvider('Refactor applied.');
    const out = collectWrites();
    const handler = vi.fn(async (): Promise<UserQuestionResponse> => ({
      action: 'decline',
      message: 'unused',
    }));

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'plan the refactor',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 5,
      onUserQuestionRequired: handler,
      stdout: out.stdout,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(provider.calls()).toBe(2);
    expect(result.plan).toBeUndefined();
  });
});
