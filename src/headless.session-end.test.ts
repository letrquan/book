import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { AgentSession } from './session/agent-session.js';
import { createDefaultRegistry, createRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { toolSuccess } from './tools/result.js';
import type { AgentConfig } from './types/runtime.js';

let tempDirs: string[] = [];

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

function abortingRegistry(controller: AbortController) {
  const registry = createRegistry();
  registry.register({
    name: 'AbortRun',
    description: 'Abort the run while this tool executes.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      controller.abort();
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
