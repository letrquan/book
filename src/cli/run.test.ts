import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import { enterInteractiveScreen, resolveHeadlessSessionProjections } from './run.js';

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  const stdout = {
    isTTY,
    write(chunk: string | Uint8Array) {
      writes.push(String(chunk));
      return true;
    },
  } as Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

  return { stdout, writes };
}

function message(
  id: string,
  content: string,
  options: { includeInContext?: boolean; kind?: 'conversation' | 'checkpoint' | 'local' } = {},
): Message {
  return {
    id,
    role: 'user',
    content,
    includeInContext: options.includeInContext ?? true,
    timestamp: 1,
    ...(options.kind === undefined ? {} : ({ kind: options.kind } as Partial<Message>)),
  };
}

describe('resolveHeadlessSessionProjections', () => {
  it('passes compact-v2 transcript, context, and boundaries without mixing projections', () => {
    const transcript = [
      message('visible', 'visible conversation'),
      message('local', 'local /context output', { includeInContext: false, kind: 'local' }),
    ];
    const contextHistory = [message('checkpoint', 'provider checkpoint', { kind: 'checkpoint' })];
    const compactBoundaries = [{ id: 'boundary-1' }];

    const projections = resolveHeadlessSessionProjections({
      history: contextHistory,
      transcript,
      contextHistory,
      compactBoundaries,
    });

    expect(projections).toEqual({
      history: contextHistory,
      transcript,
      contextHistory,
      compactBoundaries,
    });
    expect(projections.history).toBe(contextHistory);
    expect(projections.history).not.toContain(transcript[1]);
  });

  it('filters local-only rows when adapting a legacy history', () => {
    const providerMessage = message('provider', 'provider-visible');
    const hiddenMessage = message('hidden', 'hidden', { includeInContext: false });
    const localMessage = message('local', 'local', { kind: 'local' });
    const history = [providerMessage, hiddenMessage, localMessage];

    const projections = resolveHeadlessSessionProjections({ history });

    expect(projections.transcript).toBe(history);
    expect(projections.contextHistory).toEqual([providerMessage]);
    expect(projections.history).toBe(projections.contextHistory);
    expect(projections.compactBoundaries).toEqual([]);
  });
});

describe('enterInteractiveScreen', () => {
  it('enters alternate screen and enables SGR mouse reporting for TTY output', () => {
    const { stdout, writes } = fakeStdout(true);
    const restore = enterInteractiveScreen(stdout);

    expect(writes).toEqual(['\x1b[?1049h\x1b[?1000h\x1b[?1006h']);

    restore();
    restore();

    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1000h\x1b[?1006h',
      '\x1b[?1006l\x1b[?1000l\x1b[?1049l',
    ]);
  });

  it('does nothing for non-TTY output', () => {
    const { stdout, writes } = fakeStdout(false);
    const restore = enterInteractiveScreen(stdout);

    restore();

    expect(writes).toEqual([]);
  });
});
