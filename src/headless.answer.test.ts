import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry, createRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { toolSuccess } from './tools/result.js';
import type { AgentConfig } from './types/runtime.js';
import type { Message } from './types/messages.js';

let tempDirs: string[] = [];
const previousBookHome = process.env.BOOK_HOME;
let stderrWrites: string[] = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stderrWrites = [];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
    );
    return true;
  });
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(): AgentConfig {
  process.env.BOOK_HOME = tempDir('book-answer-home-');
  return defaultConfig({ baseUrl: 'http://localhost/v1', workspace: tempDir('book-answer-ws-') });
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

function toolCallDelta(index: number, id: string, name: string, args: object): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  })}\n\n`;
}

function capture() {
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

describe('runHeadless — the answer is only ever the model answering (#248)', () => {
  it('prints no answer when a tool batch with duplicate call ids is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          textDelta('Let me check both files.'),
          toolCallDelta(0, 'dup', 'Read', { file_path: 'a.txt' }),
          toolCallDelta(1, 'dup', 'Read', { file_path: 'b.txt' }),
        ]),
      ),
    );
    const out = capture();

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: 'check',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: out.stdout,
    });

    expect(result.outcome.reason).toBe('protocol_error');
    expect(out.text()).toBe('');
    expect(result.answer).toBe('');
    expect(stderrWrites.join('')).toContain('duplicate tool call IDs');
  });

  it('prints no answer, and says why on stderr, when a hook blocks the prompt', async () => {
    const config = makeConfig();
    const hook = join(config.workspace, 'block.cjs');
    writeFileSync(
      hook,
      "process.stdout.write(JSON.stringify({ action: 'block', message: 'not today' }));",
    );
    config.settings.hooks.UserPromptSubmit = [{ command: `node "${hook}"`, env: {} }];
    const fetch = vi.fn(async () => sse([textDelta('should not run')]));
    vi.stubGlobal('fetch', fetch);
    const out = capture();

    const result = await runHeadless(config, createDefaultRegistry(), {
      prompt: 'do it',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: out.stdout,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.outcome.reason).toBe('blocked_by_policy');
    expect(out.text()).toBe('');
    expect(stderrWrites.join('')).toContain('error: not today');
  });

  it('prints no earlier answer when no model turn ran in this process', async () => {
    const fetch = vi.fn(async () => sse([textDelta('unused')]));
    vi.stubGlobal('fetch', fetch);
    const history: Message[] = [
      { id: 'u1', role: 'user', content: 'old question', includeInContext: true, timestamp: 1 },
      {
        id: 'a1',
        role: 'assistant',
        content: 'OLD ANSWER FROM A PREVIOUS PROCESS',
        includeInContext: true,
        timestamp: 2,
      },
    ];
    const out = capture();

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: '/review --help',
      inputFormat: 'text',
      outputFormat: 'text',
      history,
      mode: 'bypassPermissions',
      stdout: out.stdout,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(out.text()).not.toContain('OLD ANSWER');
    expect(result.answer).toBe('');
  });

  it('marks a resolved command body as derived in the history it returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([textDelta('Reviewed.')])),
    );

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: '/init',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: capture().stdout,
    });

    const opening = result.messages.find((message) => message.role === 'user');
    expect(opening?.derivedContent).toBe(true);
    expect(result.answer).toBe('Reviewed.');
  });
});

describe('runHeadless — child progress labels (#248)', () => {
  it('tells two children of the same profile apart', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'FakeDelegateTwice',
      description: 'Report two explorer children that each run one tool.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        for (const agentId of ['child-1', 'child-2']) {
          context.onAgentEvent?.({
            type: 'agent_start',
            agent: {
              id: agentId,
              profile: 'explorer',
              name: 'explorer',
              role: 'explorer',
              description: 'Inspect',
              status: 'running',
              applicationStatus: 'not_applied',
              prompt: 'inspect',
              referencedEvidenceIds: [],
              transcript: [],
              pendingMessages: [],
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          });
        }
        for (const [agentId, file] of [
          ['child-1', 'src/a.ts'],
          ['child-2', 'src/b.ts'],
        ] as const) {
          const call = { id: `${agentId}-call`, name: 'Read', arguments: { file_path: file } };
          context.onAgentEvent?.({
            type: 'agent_activity',
            agentId,
            activity: {
              id: call.id,
              kind: 'tool',
              label: 'Using Read',
              toolName: 'Read',
              toolCall: call,
              startedAt: Date.now(),
              status: 'running',
            },
          });
        }
        return toolSuccess('delegated');
      },
    });
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        if (request === 1) return sse([toolCallDelta(0, 'call-1', 'FakeDelegateTwice', {})]);
        return sse([textDelta('done')]);
      }),
    );

    await runHeadless(makeConfig(), registry, {
      prompt: 'delegate',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      stdout: capture().stdout,
    });

    expect(stderrWrites).toContain('  [explorer] [Read] src/a.ts\n');
    expect(stderrWrites).toContain('  [explorer 2] [Read] src/b.ts\n');
  });
});
