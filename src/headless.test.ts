import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHeadless } from './headless.js';
import { SessionStore } from './session/store.js';
import { createDefaultRegistry, createRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';
import type { UserQuestionRequest } from './types/tools.js';
import { toolSuccess } from './tools/result.js';
import type { AgentEvent } from './session/agent-events.js';
import type { AgentManager } from './agents/manager.js';
import type { AgentCompletionNotification } from './agents/types.js';

const config = defaultConfig({ baseUrl: 'http://localhost/v1' });
let tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-headless-'));
  tempDirs.push(dir);
  return dir;
}

function sse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

function textDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function toolDelta(id: string, name: string, args: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  })}\n\n`;
}

function freshConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return defaultConfig({ baseUrl: 'http://localhost/v1', ...overrides });
}

beforeEach(() => {
  const provider = createRepeatingScriptedProvider(() =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'Hello!' } }] }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    ]),
  );
  vi.stubGlobal('fetch', provider.fetch);
});

describe('runHeadless — text output', () => {
  it('prints the final assistant text to stdout', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    const result = await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    expect(writes.join('')).toContain('Hello!');
    expect(result.outcome).toEqual({
      status: 'completed',
      reason: 'normal_completion',
      partialOutput: false,
    });
  });

  it('returns versioned run accounting and verified response identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          textDelta('Hello!'),
          `data: ${JSON.stringify({
            id: 'response-1',
            model: 'gpt-5',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        ]),
      ),
    );

    const result = await runHeadless(freshConfig({ model: 'gpt-5' }), createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: { write: () => true },
    });

    expect(result.runs?.[0]?.accounting).toMatchObject({
      directUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      inclusiveUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      costStatus: 'known',
      modelIdentities: [
        {
          status: 'verified',
          requestedModel: 'gpt-5',
          responseModel: 'gpt-5',
          responseId: 'response-1',
        },
      ],
      completeness: 'complete',
    });
    expect(result.runs?.[0]?.ambient).toMatchObject({
      schemaVersion: 2,
      model: { requestedModel: 'gpt-5' },
      settings: { agentsMode: 'adaptive' },
      completeness: 'partial',
    });
  });

  it('fails before a budgeted call when model pricing is unknown', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHeadless(
      freshConfig({ model: 'vendor/unknown' }),
      createDefaultRegistry(),
      {
        prompt: 'say hi',
        inputFormat: 'text',
        outputFormat: 'text',
        history: [],
        mode: 'bypassPermissions',
        maxBudgetUsd: 1,
        stdout: { write: () => true },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.outcome).toMatchObject({ status: 'failed', reason: 'budget_unverifiable' });
  });

  it('delivers shared agent events before text output encoding', async () => {
    const events: AgentEvent[] = [];

    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      onAgentEvent: (event) => events.push(event),
    });

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.slice(0, 3)).toEqual(['run_started', 'system', 'session']);
    expect(eventTypes.slice(-3)).toEqual(['text', 'result', 'done']);
    expect(
      events
        .filter((event) => event.type === 'skill_lifecycle')
        .every((event) => events.indexOf(event) < eventTypes.indexOf('text')),
    ).toBe(true);
    expect(events.find((event) => event.type === 'text')).toEqual({
      type: 'text',
      content: 'Hello!',
    });
    expect(events.find((event) => event.type === 'run_started')).toMatchObject({
      ambient: {
        schemaVersion: 2,
        settings: { agentsMode: 'adaptive' },
      },
    });
  });

  it('forwards redacted skill lifecycle events in headless mode', async () => {
    const workspace = makeWorkspace();
    const skillRoot = join(workspace, '.book', 'skills', 'review');
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Review changes',
        '---',
        'Private review procedure.',
      ].join('\n'),
    );
    const events: AgentEvent[] = [];

    await runHeadless(freshConfig({ workspace }), createDefaultRegistry(), {
      prompt: '$review inspect this change',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      onAgentEvent: (event) => events.push(event),
    });

    const lifecycle = events.filter((event) => event.type === 'skill_lifecycle');
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'skill_lifecycle',
          event: expect.objectContaining({ type: 'skill_activation_applied', skill: 'review' }),
        }),
      ]),
    );
    expect(JSON.stringify(lifecycle)).not.toContain('Private review procedure.');
  });

  it('creates one independently finalized root run per streamed user request', async () => {
    const { Readable } = await import('stream');
    const stdin = Readable.from([
      `${JSON.stringify({ type: 'user', content: 'first' })}\n`,
      `${JSON.stringify({ type: 'user', content: 'second' })}\n`,
    ]);

    const result = await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdin,
      stdout: { write: () => true },
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs?.map((run) => run.outcome.status)).toEqual(['completed', 'completed']);
    expect(result.runs?.[0]?.context).toMatchObject({ source: 'headless' });
    expect(result.runs?.[1]?.context).toMatchObject({ source: 'headless' });
    expect(result.runs?.[0]?.context.runId).toBe(result.runs?.[0]?.context.rootRunId);
    expect(result.runs?.[1]?.context.runId).toBe(result.runs?.[1]?.context.rootRunId);
    expect(result.runs?.[0]?.context.runId).not.toBe(result.runs?.[1]?.context.runId);
  });

  it('starts a new linked run when continuing persisted history', async () => {
    const history = [
      {
        id: 'prior-request',
        role: 'user' as const,
        content: 'before resume',
        includeInContext: true,
        timestamp: 1,
      },
      {
        id: 'prior-assistant',
        role: 'assistant' as const,
        content: 'before resume response',
        includeInContext: true,
        timestamp: 2,
      },
    ];

    const result = await runHeadless(config, createDefaultRegistry(), {
      prompt: 'continue',
      inputFormat: 'text',
      outputFormat: 'text',
      history,
      mode: 'bypassPermissions',
      stdout: { write: () => true },
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs?.[0]?.context).toMatchObject({
      resumedFromRunId: 'prior-request',
      source: 'headless',
    });
    expect(result.runs?.[0]?.context.runId).not.toBe('prior-request');
  });

  it('waits for background completions and routes them through a parent continuation turn', async () => {
    const workspace = makeWorkspace();
    const hookScript = join(workspace, 'block-agent-notifications.cjs');
    writeFileSync(
      hookScript,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => (input += chunk));",
        "process.stdin.on('end', () => {",
        '  const payload = JSON.parse(input);',
        "  if (payload.user_prompt?.includes('<subagent_notification>')) process.exit(2);",
        '});',
      ].join('\n'),
    );
    const runtimeConfig = freshConfig({ workspace });
    runtimeConfig.settings.hooks.UserPromptSubmit = [{ command: `node "${hookScript}"`, env: {} }];
    const notification: AgentCompletionNotification = {
      deliveryId: 'child-1:1',
      sequence: 1,
      rootRunId: 'persisted-root-run',
      runId: 'persisted-child-run',
      completion: {
        agentId: 'child-1',
        displayName: 'Atlas',
        profile: 'explorer',
        status: 'failed',
        resolvedModel: 'test/model',
        isolation: 'workspace-readonly',
        summary: 'Found the missing delivery bridge',
        evidenceIds: ['evidence-1'],
        createdAt: 1,
        startedAt: 2,
        updatedAt: 3,
        finishedAt: 3,
      },
    };
    let pending = [notification];
    const acknowledgeCompletion = vi.fn(async () => {
      pending = [];
    });
    const fakeManager = {
      waitForIdle: vi.fn(async () => {}),
      listPendingCompletions: vi.fn(async () => pending),
      acknowledgeCompletion,
      dispose: vi.fn(),
    } as unknown as AgentManager;
    const registry = createRegistry();
    registry.register({
      name: 'SpawnFakeAgent',
      description: 'Create a deterministic fake background completion for the host test.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        notification.parentSessionId = context.parentSessionId;
        context.runtime!.agentManager = fakeManager;
        context.onAgentEvent?.({
          type: 'agent_result',
          agent: {
            id: 'child-1',
            profile: 'explorer',
            name: 'explorer',
            role: 'explorer',
            description: 'Inspect the task',
            parentSessionId: context.parentSessionId,
            rootRunId: 'persisted-root-run',
            parentRunId: context.runContext?.runId,
            runId: 'persisted-child-run',
            status: 'failed',
            applicationStatus: 'not_applied',
            prompt: 'inspect',
            referencedEvidenceIds: [],
            transcript: [],
            pendingMessages: [],
            result: 'partial child result',
            error: 'child provider failed',
            runOutcome: {
              status: 'failed',
              reason: 'provider_error',
              partialOutput: true,
              message: 'child provider failed',
            },
            runUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
            runStartedAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
        return toolSuccess('spawned');
      },
    });
    let requestCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestCount++;
        if (requestCount === 1) return sse([toolDelta('spawn', 'SpawnFakeAgent', {})]);
        if (requestCount === 2) return sse([textDelta('Background work started.')]);
        expect(String(init?.body)).toContain('<subagent_notification>');
        return sse([textDelta('Integrated the child report.')]);
      }),
    );

    const result = await runHeadless(runtimeConfig, registry, {
      prompt: 'delegate',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 3,
      stdout: { write: () => true },
    });

    expect(requestCount).toBe(3);
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        kind: 'agent-notification',
        content: expect.stringContaining('Atlas'),
      }),
    );
    expect(result.messages.at(-1)?.content).toContain('Integrated the child report.');
    expect(acknowledgeCompletion).toHaveBeenCalledWith('child-1:1');
    expect(result.runs).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({
          runId: 'persisted-child-run',
          rootRunId: 'persisted-root-run',
        }),
        outcome: expect.objectContaining({ status: 'failed', reason: 'provider_error' }),
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      }),
    );
    expect(result.runs?.at(-1)?.context).toMatchObject({
      rootRunId: 'persisted-root-run',
      parentRunId: 'persisted-child-run',
    });
  });

  it('expands @ file mentions before sending prompts to the provider', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export const value = 1;');
    let requestBody = '';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        requestBody = String((init as RequestInit).body);
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    await runHeadless(
      defaultConfig({ baseUrl: 'http://localhost/v1', workspace: ws }),
      createDefaultRegistry(),
      {
        prompt: 'Explain @src/app.ts',
        inputFormat: 'text',
        outputFormat: 'text',
        history: [],
        mode: 'bypassPermissions',
        stdout: { write: () => true },
      },
    );

    expect(requestBody).toContain('Contents of src/app.ts:');
    expect(requestBody).toContain('export const value = 1;');
  });

  it('keeps original @ mentions in returned and persisted history', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export const value = 1;');
    const sessions = new SessionStore(makeWorkspace());

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const result = await runHeadless(
      defaultConfig({ baseUrl: 'http://localhost/v1', workspace: ws }),
      createDefaultRegistry(),
      {
        prompt: 'Explain @src/app.ts',
        inputFormat: 'text',
        outputFormat: 'text',
        history: [],
        mode: 'bypassPermissions',
        stdout: { write: () => true },
        sessionStore: sessions,
      },
    );

    expect(result.messages[0].content).toBe('Explain @src/app.ts');
    expect(result.messages[0].contextContent).toContain('Contents of src/app.ts:');
    const loaded = sessions.load(result.sessionId!);
    expect(loaded.history[0].content).toBe('Explain @src/app.ts');
    expect(loaded.meta.name).toBe('Explain @src/app.ts');
  });
});

describe('runHeadless — json output', () => {
  it('emits one JSON object with messages and usage', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const out = writes.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.usage.totalTokens).toBe(7);
    expect(parsed.result.messages.length).toBeGreaterThan(0);
    expect(parsed.result.outcome).toEqual({
      status: 'completed',
      reason: 'normal_completion',
      partialOutput: false,
    });
  });

  it('returns an interrupted outcome when the provider stream is truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const result = await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: { write: () => true },
    });

    expect(result.outcome).toEqual({
      status: 'interrupted',
      reason: 'transport_interrupted',
      message: 'Provider stream ended before its terminal event.',
      partialOutput: true,
    });
  });
});

describe('runHeadless — stream-json output', () => {
  it('emits system, assistant, result events as newline-delimited JSON', async () => {
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    const lines = writes.join('').split('\n').filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types[0]).toBe('system');
    expect(types).toContain('assistant');
    expect(types[types.length - 1]).toBe('result');
    expect(JSON.parse(lines.at(-1)!).result.outcome).toEqual({
      status: 'completed',
      reason: 'normal_completion',
      partialOutput: false,
    });
  });

  it('emits a pre-created durable session id', async () => {
    const sessions = new SessionStore(makeWorkspace());
    const sessionId = sessions.create({ cwd: config.workspace });
    const writes: string[] = [];

    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout: {
        write: (s: string) => {
          writes.push(s);
          return true;
        },
      },
      sessionStore: sessions,
      sessionId,
      sessionCreated: true,
    });

    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual({ type: 'session', session_id: sessionId });
  });

  it('hydrates resumed image history when generating prompt suggestions', async () => {
    const sessions = new SessionStore(makeWorkspace());
    const sessionId = sessions.create({ cwd: config.workspace });
    const attachment = sessions.saveImageAttachment(sessionId, {
      bytes: Uint8Array.from([137, 80, 78, 71, 1]),
      mediaType: 'image/png',
    });
    const requests: Array<{ messages?: unknown[] }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { messages?: unknown[] };
        requests.push(request);
        return requests.length === 1
          ? sse([textDelta('Done.')])
          : sse([textDelta('["Inspect the image again"]')]);
      }),
    );
    const writes: string[] = [];

    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'continue',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [
        {
          id: 'image-turn',
          role: 'user',
          content: 'What is shown?',
          attachments: [attachment],
          includeInContext: true,
          timestamp: 1,
        },
      ],
      mode: 'bypassPermissions',
      stdout: { write: (value) => (writes.push(value), true) },
      sessionStore: sessions,
      sessionId,
      promptSuggestions: true,
    });

    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).toContain('data:image/png;base64,');
    expect(events).toContainEqual({
      type: 'prompt_suggestions',
      suggestions: ['Inspect the image again'],
    });
  });

  it('emits structured user-question events and invokes an interactive host callback', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        return fetchCalls === 1
          ? sse([
              toolDelta('ask-1', 'AskUserQuestion', {
                questions: [
                  {
                    question: 'Which mode?',
                    header: 'Mode',
                    options: [
                      { label: 'Fast', description: 'Less detail' },
                      { label: 'Deep', description: 'More detail' },
                    ],
                    multiSelect: false,
                  },
                ],
              }),
            ])
          : sse([textDelta('Continuing with Deep.')]);
      }),
    );
    const writes: string[] = [];
    const handler = vi.fn(async (request: UserQuestionRequest) => ({
      action: 'answer' as const,
      answers: { [request.questions[0].question]: 'Deep' },
    }));

    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'choose',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 2,
      onUserQuestionRequired: handler,
      stdout: { write: (value) => (writes.push(value), true) },
    });

    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(handler).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_question', status: 'pending' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user_question_result',
        response: expect.objectContaining({ action: 'answer' }),
      }),
    );
  });

  it('reports user input as unavailable when no interactive handler exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          toolDelta('ask-1', 'AskUserQuestion', {
            questions: [
              {
                question: 'Continue?',
                header: 'Continue',
                options: [
                  { label: 'Yes', description: 'Continue' },
                  { label: 'No', description: 'Stop' },
                ],
                multiSelect: false,
              },
            ],
          }),
        ]),
      ),
    );
    const writes: string[] = [];

    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'choose',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: 1,
      stdout: { write: (value) => (writes.push(value), true) },
    });

    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'user_question', status: 'unavailable' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user_question_result',
        response: expect.objectContaining({ action: 'decline' }),
      }),
    );
  });
});

describe('runHeadless — stream-json input', () => {
  it('reads newline-delimited user messages from stdin', async () => {
    const { Readable } = await import('stream');
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'first' }) + '\n',
      JSON.stringify({ type: 'user', content: 'second' }) + '\n',
    ]);
    await runHeadless(config, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      stdin,
    });
    const parsed = JSON.parse(writes.join('').trim());
    // Two prompts -> at least two assistant messages in history.
    const assistantCount = parsed.result.messages.filter(
      (m: { role: string }) => m.role === 'assistant',
    ).length;
    expect(assistantCount).toBeGreaterThanOrEqual(2);
  });
});

describe('runHeadless — json-schema', () => {
  it('returns validated JSON matching the schema', async () => {
    // Provider yields JSON content.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([textDelta('{"name":"book"}')])),
    );

    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'return json',
      inputFormat: 'text',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      jsonSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    const parsed = JSON.parse(writes.join('').trim());
    expect(parsed.result.structured).toEqual({ name: 'book' });
  });
});

describe('runHeadless — runtime stores', () => {
  it('retains discovered tools across stream-json prompts', async () => {
    const requestTools: string[][] = [];
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          tools?: Array<{ function: { name: string } }>;
        };
        requestTools.push(body.tools?.map((tool) => tool.function.name) ?? []);
        fetchCalls++;
        return fetchCalls === 1
          ? sse([toolDelta('search-1', 'ToolSearch', { query: 'special capability 3' })])
          : sse([textDelta('found')]);
      }),
    );

    const registry = createRegistry();
    for (let index = 0; index < 12; index++) {
      registry.register({
        name: `SpecialTool${index}`,
        description: `Special capability ${index}`,
        parameters: { type: 'object', properties: {} },
        execute: async () => toolSuccess('special'),
      });
    }

    const { Readable } = await import('stream');
    const runtimeConfig = freshConfig({ maxTurns: 1 });
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'find the special tool' }) + '\n',
      JSON.stringify({ type: 'user', content: 'use the discovered tool' }) + '\n',
    ]);

    await runHeadless(runtimeConfig, registry, {
      inputFormat: 'stream-json',
      outputFormat: 'json',
      history: [],
      mode: 'bypassPermissions',
      stdout: { write: () => true },
      stdin,
    });

    expect(requestTools[0]).toContain('ToolSearch');
    expect(requestTools[0]).not.toContain('SpecialTool3');
    expect(requestTools[1]).toContain('SpecialTool3');
  });

  it('shares task state across stream-json prompts', async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls++;
        if (fetchCalls === 1) {
          return sse([toolDelta('task_create', 'TaskCreate', { subject: 'Across prompts' })]);
        }
        if (fetchCalls === 2) {
          return sse([textDelta('created')]);
        }
        if (fetchCalls === 3) {
          return sse([toolDelta('task_list', 'TaskList', {})]);
        }
        return sse([textDelta('listed')]);
      }),
    );

    const { Readable } = await import('stream');
    const writes: string[] = [];
    const stdout = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    };
    const runtimeConfig = deepFreeze(freshConfig({ maxTurns: 2 }));
    const stdin = Readable.from([
      JSON.stringify({ type: 'user', content: 'create task' }) + '\n',
      JSON.stringify({ type: 'user', content: 'list tasks' }) + '\n',
    ]);

    await runHeadless(runtimeConfig, createDefaultRegistry(), {
      inputFormat: 'stream-json',
      outputFormat: 'stream-json',
      history: [],
      mode: 'bypassPermissions',
      stdout,
      stdin,
    });

    const toolResults = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'tool_result');

    expect(toolResults.at(-1).tool_result.content).toContain('#1 Across prompts');
    expect('tasks' in runtimeConfig).toBe(false);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
