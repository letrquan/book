import { EventEmitter } from 'node:events';
import { Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalKeyHandler, installCtrlCSplitting, splitCtrlCBytes } from './global-key-handler.js';
import type { DebugLogger } from '../debug-log.js';

afterEach(() => cleanup());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/** A child whose handler re-subscribes on demand, as a focus-gated composer does. */
function Child({ calls }: { calls: string[] }) {
  const [active, setActive] = useState(true);
  useInput(
    (input) => {
      calls.push(`child:${input}`);
      if (input === 't') {
        setActive(false);
        setTimeout(() => setActive(true), 0);
      }
    },
    { isActive: active },
  );
  return <Text>child</Text>;
}

describe('GlobalKeyHandler', () => {
  it('runs before a descendant handler, even after the descendant re-subscribes', async () => {
    const calls: string[] = [];
    const view = render(
      <>
        <GlobalKeyHandler onInput={(input) => calls.push(`global:${input}`)} />
        <Child calls={calls} />
      </>,
    );
    await settle();

    view.stdin.write('a');
    await settle();
    expect(calls).toEqual(['global:a', 'child:a']);

    view.stdin.write('t');
    await settle();
    await settle();
    calls.length = 0;
    view.stdin.write('b');
    await settle();
    expect(calls).toEqual(['global:b', 'child:b']);
  });

  it('would run after the descendant if subscribed from the parent body', async () => {
    const calls: string[] = [];
    function Parent() {
      useInput((input) => calls.push(`parent:${input}`));
      return <Child calls={calls} />;
    }
    const view = render(<Parent />);
    await settle();

    view.stdin.write('a');
    await settle();
    expect(calls).toEqual(['child:a', 'parent:a']);
  });
});

describe('splitCtrlCBytes (#504)', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  function recorder() {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    emitter.on('input', (chunk) => seen.push(chunk));
    return { emitter, seen };
  }

  it.each([
    ['\x03\x03', ['\x03', '\x03']],
    ['\x03\x03\x03', ['\x03', '\x03', '\x03']],
    ['q\x03\x03', ['q', '\x03', '\x03']],
    ['\x03\r', ['\x03', '\r']],
    ['\x03x', ['\x03', 'x']],
    ['ab\x03cd\x03', ['ab', '\x03', 'cd', '\x03']],
  ])('splits %j into its text and Ctrl+C pieces, in order', async (chunk, pieces) => {
    const { emitter, seen } = recorder();
    splitCtrlCBytes(emitter);

    emitter.emit('input', chunk);
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();

    expect(seen).toEqual(pieces);
  });

  it('delivers one piece per turn of the event loop, so each sees what the last one did', async () => {
    const { emitter, seen } = recorder();
    splitCtrlCBytes(emitter);

    emitter.emit('input', '\x03\x03\x03');
    expect(seen).toEqual(['\x03']);
    await tick();
    expect(seen).toEqual(['\x03', '\x03']);
    await tick();
    expect(seen).toEqual(['\x03', '\x03', '\x03']);
  });

  it('leaves a chunk with no Ctrl+C byte, a lone one, a sequence and a paste event alone, at once', () => {
    const { emitter, seen } = recorder();
    const pastes: unknown[] = [];
    emitter.on('paste', (text) => pastes.push(text));
    splitCtrlCBytes(emitter);

    emitter.emit('input', 'hello\r');
    emitter.emit('input', '\x1b[A');
    emitter.emit('input', '\x03');
    emitter.emit('paste', 'a\x03\x03b');

    expect(seen).toEqual(['hello\r', '\x1b[A', '\x03']);
    expect(pastes).toEqual(['a\x03\x03b']);
  });

  it('queues input read meanwhile behind the pieces still waiting', async () => {
    const { emitter, seen } = recorder();
    splitCtrlCBytes(emitter);

    emitter.emit('input', '\x03\x03');
    emitter.emit('input', 'later');
    expect(seen).toEqual(['\x03']);
    await tick();
    await tick();

    expect(seen).toEqual(['\x03', '\x03', 'later']);
  });

  it('drops the pieces still waiting, and stops splitting, once removed', async () => {
    const { emitter, seen } = recorder();
    const restore = splitCtrlCBytes(emitter);

    emitter.emit('input', '\x03\x03\x03');
    restore();
    await tick();
    await tick();
    emitter.emit('input', '\x03\x03');

    expect(seen).toEqual(['\x03', '\x03\x03']);
  });
});

describe('installCtrlCSplitting (#504)', () => {
  function logger() {
    const warn = vi.fn<(...args: unknown[]) => void>();
    const log: DebugLogger = { debug: vi.fn(), info: vi.fn(), warn, event: vi.fn() };
    return Object.assign(log, { warn });
  }

  it('says so in the debug log when Ink offers no input emitter, and does nothing else', () => {
    const log = logger();

    expect(installCtrlCSplitting(undefined, log)).toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]?.[0])).toContain('internal_eventEmitter');
  });

  it('installs quietly when there is an emitter', () => {
    const log = logger();
    const emitter = new EventEmitter();
    const restore = installCtrlCSplitting(emitter, log);

    expect(restore).toBeTypeOf('function');
    expect(log.warn).not.toHaveBeenCalled();
    restore?.();
  });
});

describe('GlobalKeyHandler — Ctrl+C bytes read together (#504)', () => {
  it('reaches every subscriber as separate presses, never as one unnamed chunk', async () => {
    const calls: string[] = [];
    function Probe() {
      useInput((input, key) =>
        calls.push(`probe:${key.ctrl ? 'ctrl+' : ''}${JSON.stringify(input)}`),
      );
      return <Text>probe</Text>;
    }
    const view = render(
      <>
        <GlobalKeyHandler
          onInput={(input, key) => calls.push(`global:${key.ctrl ? 'ctrl+' : ''}${input}`)}
        />
        <Probe />
      </>,
    );
    await settle();

    view.stdin.write('\x03\x03\x03');
    await settle();

    expect(calls).toEqual([
      'global:ctrl+c',
      'probe:ctrl+"c"',
      'global:ctrl+c',
      'probe:ctrl+"c"',
      'global:ctrl+c',
      'probe:ctrl+"c"',
    ]);
  });

  it('splits Ctrl+C out of text read with it, and leaves a paste-like chunk alone', async () => {
    const calls: string[] = [];
    const view = render(
      <GlobalKeyHandler onInput={(input, key) => calls.push(`${key.ctrl ? '^' : ''}${input}`)} />,
    );
    await settle();

    view.stdin.write('hello\r');
    view.stdin.write('q\x03\x03');
    view.stdin.write('\x03\r');
    await settle();

    expect(calls).toEqual(['hello\r', 'q', '^c', '^c', '^c', '\r']);
  });
});
