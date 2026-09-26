import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PassThrough, Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { AgentSession } from './session/agent-session.js';
import { createDefaultRegistry, createRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { toolSuccess } from './tools/result.js';
import type { AgentConfig } from './types/runtime.js';
import type { AgentManager } from './agents/manager.js';

let tempDirs: string[] = [];

// Pin Book's home: a run writes its liveness file under it, and the real one is the
// developer's own ~/.book.
const previousBookHome = process.env.BOOK_HOME;
let bookHome: string;

beforeEach(() => {
  bookHome = mkdtempSync(join(tmpdir(), 'book-home-'));
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(bookHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

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

function toolDelta(id: string, name: string): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] } }],
  })}\n\n`;
}

function sessionEndConfig(): AgentConfig {
  const workspace = mkdtempSync(join(tmpdir(), 'book-session-end-'));
  tempDirs.push(workspace);
  const config = defaultConfig({ baseUrl: 'http://localhost/v1', workspace });
  config.settings.hooks.SessionEnd = [{ command: 'exit 0', env: {} }];
  return config;
}

interface SessionEndRecord {
  reason?: string;
  status?: string | null;
  stopReason?: string | null;
}

function sessionEndRecords(writes: string[]): SessionEndRecord[] {
  return writes
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEndRecord & { type?: string; event?: string })
    .filter((record) => record.type === 'hook_event' && record.event === 'SessionEnd');
}

function streamOptions(signal: AbortSignal | undefined, writes: string[]) {
  return {
    prompt: 'go',
    inputFormat: 'text' as const,
    outputFormat: 'stream-json' as const,
    includeHookEvents: true,
    history: [],
    mode: 'bypassPermissions' as const,
    sessionId: 'session-under-test',
    signal,
    stdout: {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
    },
  };
}

function abortingRegistry(controller: AbortController, reason?: unknown) {
  const registry = createRegistry();
  registry.register({
    name: 'AbortRun',
    description: 'Abort the run while this tool executes.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      controller.abort(reason);
      return toolSuccess('aborted');
    },
  });
  return registry;
}

describe('runHeadless — SessionEnd reports how the run ended (#248)', () => {
  it('passes the completed outcome as status and stop reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([textDelta('done')])),
    );
    const writes: string[] = [];

    await runHeadless(
      sessionEndConfig(),
      createDefaultRegistry(),
      streamOptions(undefined, writes),
    );

    expect(sessionEndRecords(writes)).toEqual([
      expect.objectContaining({
        reason: 'completion',
        status: 'completed',
        stopReason: 'normal_completion',
      }),
    ]);
  });

  it('tells a timed-out run apart from a completed one', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        return sse([]);
      }),
    );
    const writes: string[] = [];

    await runHeadless(
      sessionEndConfig(),
      createDefaultRegistry(),
      streamOptions(controller.signal, writes),
    );

    expect(sessionEndRecords(writes)).toEqual([
      expect.objectContaining({ status: 'timed_out', stopReason: 'provider_timeout' }),
    ]);
  });

  it('reports a cancelled run when the abort lands inside a tool', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([toolDelta('call-1', 'AbortRun')])),
    );
    const writes: string[] = [];

    await expect(
      runHeadless(
        sessionEndConfig(),
        abortingRegistry(controller),
        streamOptions(controller.signal, writes),
      ),
    ).rejects.toThrow();

    expect(sessionEndRecords(writes)).toEqual([
      expect.objectContaining({
        reason: 'aborted',
        status: 'cancelled',
        stopReason: 'caller_cancelled',
      }),
    ]);
  });

  it('keeps the abort reason when the abort lands inside a tool', async () => {
    const cases = [
      {
        reason: Object.assign(new Error('Cancelled'), { bookTerminalReason: 'user_cancelled' }),
        expected: { status: 'cancelled', stopReason: 'user_cancelled' },
      },
      {
        reason: new DOMException('The operation timed out.', 'TimeoutError'),
        expected: { status: 'timed_out', stopReason: 'provider_timeout' },
      },
    ];
    for (const { reason, expected } of cases) {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => sse([toolDelta('call-1', 'AbortRun')])),
      );
      const writes: string[] = [];

      await expect(
        runHeadless(
          sessionEndConfig(),
          abortingRegistry(controller, reason),
          streamOptions(controller.signal, writes),
        ),
      ).rejects.toThrow();

      expect(sessionEndRecords(writes)).toEqual([
        expect.objectContaining({ reason: 'aborted', ...expected }),
      ]);
    }
  });

  it('reports a failed run when the run throws after SessionStart', async () => {
    const writes: string[] = [];

    await expect(
      runHeadless(sessionEndConfig(), createDefaultRegistry(), {
        ...streamOptions(undefined, writes),
        prompt: undefined,
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow('print mode requires a prompt');

    expect(sessionEndRecords(writes)).toEqual([
      expect.objectContaining({ reason: 'error', status: 'failed', stopReason: 'runtime_error' }),
    ]);
  });
});

describe('runHeadless — SessionEnd runs after the session is disposed (#248)', () => {
  /** Whether `dispose` was first called before the one `endLifecycle` call. */
  function disposeBeforeEnd() {
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    const endLifecycle = vi.spyOn(AgentSession.prototype, 'endLifecycle');
    return () =>
      dispose.mock.invocationCallOrder.length > 0 &&
      endLifecycle.mock.invocationCallOrder.length === 1 &&
      dispose.mock.invocationCallOrder[0] < endLifecycle.mock.invocationCallOrder[0];
  }

  it('stops background work before SessionEnd hooks when the run completes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([textDelta('done')])),
    );
    const disposedFirst = disposeBeforeEnd();

    await runHeadless(sessionEndConfig(), createDefaultRegistry(), streamOptions(undefined, []));

    expect(disposedFirst()).toBe(true);
  });

  it('stops background work before SessionEnd hooks when the abort lands inside a tool', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse([toolDelta('call-1', 'AbortRun')])),
    );
    const disposedFirst = disposeBeforeEnd();

    await expect(
      runHeadless(
        sessionEndConfig(),
        abortingRegistry(controller),
        streamOptions(controller.signal, []),
      ),
    ).rejects.toThrow();

    expect(disposedFirst()).toBe(true);
  });
});

describe('runHeadless — an abort stops waiting (#248)', () => {
  it('stops waiting for background children when the run is cancelled', async () => {
    const controller = new AbortController();
    const fakeManager = {
      // Children that never finish: only the abort can end the wait.
      waitForIdle: vi.fn(() => {
        setTimeout(() => controller.abort(), 20);
        return new Promise<void>(() => {});
      }),
      listPendingCompletions: vi.fn(async () => []),
      acknowledgeCompletion: vi.fn(async () => {}),
      dispose: vi.fn(),
    } as unknown as AgentManager;
    const registry = createRegistry();
    registry.register({
      name: 'SpawnFakeAgent',
      description: 'Leave a background child running.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        context.runtime!.agentManager = fakeManager;
        return toolSuccess('spawned');
      },
    });
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        return request === 1
          ? sse([toolDelta('call-1', 'SpawnFakeAgent')])
          : sse([textDelta('started it')]);
      }),
    );
    const writes: string[] = [];

    const result = await runHeadless(
      sessionEndConfig(),
      registry,
      streamOptions(controller.signal, writes),
    );

    expect(result.outcome.status).toBe('cancelled');
    expect(sessionEndRecords(writes)).toEqual([expect.objectContaining({ reason: 'aborted' })]);
  }, 10_000);

  it('stops reading a prompt from stdin when the run is cancelled', async () => {
    for (const inputFormat of ['text', 'stream-json'] as const) {
      const controller = new AbortController();
      const stdin = new PassThrough();
      setTimeout(() => controller.abort(), 20);
      const writes: string[] = [];

      await expect(
        runHeadless(sessionEndConfig(), createDefaultRegistry(), {
          ...streamOptions(controller.signal, writes),
          prompt: undefined,
          inputFormat,
          stdin,
        }),
      ).rejects.toThrow();

      expect(sessionEndRecords(writes), inputFormat).toEqual([
        expect.objectContaining({ reason: 'aborted' }),
      ]);
    }
  }, 10_000);
});

describe('runHeadless — a failure outlives a reader that leaves (#248)', () => {
  function duplicateIdsTurn(): Response {
    const call = (index: number) =>
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index, id: 'dup', function: { name: 'Read', arguments: '{"file_path":"a"}' } },
              ],
            },
          },
        ],
      })}\n\n`;
    return sse([call(0), call(1)]);
  }

  /** Aborts the run's signal as soon as the run writes a record matching `trigger`. */
  function readerLeavesAfter(trigger: string, controller: AbortController, writes: string[]) {
    return {
      write: (s: string) => {
        writes.push(s);
        if (s.includes(trigger)) controller.abort();
        return true;
      },
    };
  }

  it('keeps a failed outcome, and SessionEnd reason error, when the reader then goes away', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => duplicateIdsTurn()),
    );
    const writes: string[] = [];

    const result = await runHeadless(sessionEndConfig(), createDefaultRegistry(), {
      ...streamOptions(controller.signal, writes),
      stdout: readerLeavesAfter('"type":"error"', controller, writes),
    });

    expect(result.outcome.status).toBe('failed');
    expect(sessionEndRecords(writes)).toEqual([
      expect.objectContaining({ reason: 'error', status: 'failed' }),
    ]);
  });

  it('keeps a failed outcome when children exist and the reader goes away', async () => {
    const controller = new AbortController();
    const fakeManager = {
      waitForIdle: vi.fn(async () => {}),
      listPendingCompletions: vi.fn(async () => []),
      acknowledgeCompletion: vi.fn(async () => {}),
      dispose: vi.fn(),
    } as unknown as AgentManager;
    const registry = createRegistry();
    registry.registerAll(createDefaultRegistry().getDefinitions());
    registry.register({
      name: 'SpawnFakeAgent',
      description: 'Create the managed-agent runtime.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        context.runtime!.agentManager = fakeManager;
        return toolSuccess('spawned');
      },
    });
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        return request === 1 ? sse([toolDelta('call-1', 'SpawnFakeAgent')]) : duplicateIdsTurn();
      }),
    );
    const writes: string[] = [];

    const result = await runHeadless(sessionEndConfig(), registry, {
      ...streamOptions(controller.signal, writes),
      stdout: readerLeavesAfter('"type":"error"', controller, writes),
    });

    expect(result.outcome.status).toBe('failed');
  });

  it('marks a rejected tool batch as a host notice on the stream-json assistant record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => duplicateIdsTurn()),
    );
    const writes: string[] = [];

    await runHeadless(
      sessionEndConfig(),
      createDefaultRegistry(),
      streamOptions(undefined, writes),
    );

    const complete = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.type === 'assistant' && record.complete);
    expect(complete).toEqual([expect.objectContaining({ host_notice: true })]);
  });
});

describe('runHeadless — a cancelled wait leaves nothing unhandled (#248)', () => {
  it('does not leak a rejection from children that fail after the cancel', async () => {
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const fakeManager = {
      waitForIdle: vi.fn(() => {
        setTimeout(() => controller.abort(), 10);
        return new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 60));
      }),
      listPendingCompletions: vi.fn(async () => []),
      acknowledgeCompletion: vi.fn(async () => {}),
      dispose: vi.fn(),
    } as unknown as AgentManager;
    const registry = createRegistry();
    registry.register({
      name: 'SpawnFakeAgent',
      description: 'Leave a background child running.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        context.runtime!.agentManager = fakeManager;
        return toolSuccess('spawned');
      },
    });
    let request = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        request++;
        return request === 1
          ? sse([toolDelta('call-1', 'SpawnFakeAgent')])
          : sse([textDelta('started it')]);
      }),
    );

    try {
      await runHeadless(sessionEndConfig(), registry, streamOptions(controller.signal, []));
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  }, 10_000);
});
