import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHeadless } from './headless.js';
import { SessionStore } from './session/store.js';
import { createDefaultRegistry, createRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import type { AgentConfig, UserQuestionRequest } from './types.js';
import { toolSuccess } from './tools/result.js';

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
  // Fake provider: yields one text chunk then [DONE] with usage.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      sse([
        textDelta('Hello!'),
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
      ]),
    ),
  );
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
    await runHeadless(config, createDefaultRegistry(), {
      prompt: 'say hi',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout,
    });
    expect(writes.join('')).toContain('Hello!');
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
    expect(sessions.load(result.sessionId!).history[0].content).toBe('Explain @src/app.ts');
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
    const runtimeConfig = freshConfig({ maxTurns: 2 });
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
    expect(runtimeConfig.tasks).toHaveLength(1);
  });
});
