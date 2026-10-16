import { EventEmitter } from 'node:events';
import { Text, useInput } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalKeyHandler, splitCtrlCRuns } from './global-key-handler.js';

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

describe('GlobalKeyHandler — a run of Ctrl+C bytes in one read (#504)', () => {
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

  it('leaves a lone Ctrl+C, text and a paste-like chunk alone', async () => {
    const calls: string[] = [];
    const view = render(
      <GlobalKeyHandler onInput={(input) => calls.push(JSON.stringify(input))} />,
    );
    await settle();

    view.stdin.write('\x03');
    view.stdin.write('hello\r');
    await settle();

    expect(calls).toEqual(['"c"', '"hello\\r"']);
  });

  it('stops splitting once the handler unmounts', async () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    emitter.on('input', (chunk) => seen.push(chunk));
    const restore = splitCtrlCRuns(emitter);
    emitter.emit('input', '\x03\x03');
    restore();
    emitter.emit('input', '\x03\x03');

    expect(seen).toEqual(['\x03', '\x03', '\x03\x03']);
  });
});
