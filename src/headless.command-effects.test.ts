/**
 * The host-effect half of print-mode slash commands: what `runHeadless` does
 * with a dispatch that an effect handler already performed.
 *
 * No built-in produces a `handled` dispatch yet (the `/review` host effect is
 * the first one), so the dispatcher is stubbed here to exercise the host branch
 * the next handler will land on.
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrintCommandDispatch } from './commands/print-dispatch.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';

const stub = vi.hoisted(() => ({ dispatch: undefined as PrintCommandDispatch | undefined }));

vi.mock('./commands/print-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commands/print-dispatch.js')>();
  return {
    ...actual,
    resolvePrintCommand: async (
      ...args: Parameters<typeof actual.resolvePrintCommand>
    ): Promise<PrintCommandDispatch> => stub.dispatch ?? actual.resolvePrintCommand(...args),
  };
});

const { runHeadless } = await import('./headless.js');

let tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  stub.dispatch = undefined;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeConfig(): AgentConfig {
  const workspace = mkdtempSync(join(tmpdir(), 'book-headless-effect-'));
  tempDirs.push(workspace);
  return defaultConfig({ baseUrl: 'http://localhost/v1', workspace });
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

describe('runHeadless — a host effect performed by its handler', () => {
  it('prints the handler output and runs no model turn', async () => {
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'unused' } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    stub.dispatch = { kind: 'handled', command: 'review', output: '2 findings' };
    const out = collectWrites();

    const result = await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: '/review',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'default',
      maxTurns: 1,
      stdout: out.stdout,
    });

    expect(out.text()).toBe('2 findings\n');
    expect(provider.requests.length).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it('emits handler output as a stream-json record instead of raw text', async () => {
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'unused' } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    stub.dispatch = { kind: 'handled', command: 'review', output: '2 findings' };
    const out = collectWrites();

    await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: '/review',
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: 'default',
      maxTurns: 1,
      stdout: out.stdout,
    });

    const events = out
      .text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual({
      type: 'command_result',
      command: 'review',
      output: '2 findings',
    });
    // Every line stays parseable JSON: no bare report text in the stream.
    expect(provider.requests.length).toBe(0);
  });

  it('runs no turn and writes nothing when the handler reports no output', async () => {
    const provider = createRepeatingScriptedProvider(() =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'unused' } }] })]),
    );
    vi.stubGlobal('fetch', provider.fetch);
    stub.dispatch = { kind: 'handled', command: 'review' };
    const out = collectWrites();

    await runHeadless(makeConfig(), createDefaultRegistry(), {
      prompt: '/review',
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'default',
      maxTurns: 1,
      stdout: out.stdout,
    });

    expect(out.text()).toBe('');
    expect(provider.requests.length).toBe(0);
  });
});
