/**
 * The `attempt_discarded` record names the cause (#686), seen from a print run.
 *
 * A content-filter retry used to be reported as `empty_response`, the one cause the record
 * was written for, so a reader could not tell it from an empty completion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { isolateBookHome } from './test/isolated-book-home.js';
import { createScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { StreamJsonEvent } from './stream-json.js';

let workspace: string;

isolateBookHome('book-discard-reason-home-');

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-discard-reason-workspace-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(workspace, { recursive: true, force: true });
});

const reply = (text: string, finishReason: string): Response =>
  sseResponse([
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    JSON.stringify({
      id: 'response-1',
      model: 'gpt-5',
      choices: [{ delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }),
  ]);

describe('a content-filter retry, in print mode (#686)', () => {
  it('writes an attempt_discarded record that says content_filter', async () => {
    const provider = createScriptedProvider(
      reply('x'.repeat(48), 'content_filter'),
      reply('normal answer', 'stop'),
    );
    vi.stubGlobal('fetch', provider.fetch);
    const writes: string[] = [];

    await runHeadless(
      defaultConfig({ baseUrl: 'http://localhost/v1', workspace }),
      createDefaultRegistry(),
      {
        prompt: 'say hi',
        inputFormat: 'text',
        outputFormat: 'stream-json',
        history: [],
        mode: 'bypassPermissions',
        stdout: {
          write: (line: string) => {
            writes.push(line);
            return true;
          },
        },
      },
    );
    const events = writes
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StreamJsonEvent);

    expect(provider.requests).toHaveLength(2);
    expect(events.filter((event) => event.type === 'attempt_discarded')).toEqual([
      { type: 'attempt_discarded', reason: 'content_filter' },
    ]);
  });
});
