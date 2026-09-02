import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Text, useInput } from 'ink';
import { useKeyState } from './useKeyState.js';

afterEach(cleanup);

/**
 * The behaviour these cover is the one a plain `useState` does not have: a key
 * handler reading back a value it set earlier in the same batch. Ink delivers a
 * whole stdin chunk to its handlers in one go, so that batch is what a paste or
 * a fast key repeat produces in a real terminal.
 */
describe('useKeyState', () => {
  it('reads back what the same batch just wrote', () => {
    const seen: number[] = [];
    function Probe() {
      const [, setCount, count] = useKeyState(0);
      useInput(() => {
        setCount(count() + 1);
        seen.push(count());
      });
      return null;
    }

    const view = render(<Probe />);
    // Three keys in ONE write. They have to be escape-prefixed: Ink splits a
    // chunk at escape bytes only, so 'abc' would arrive as a single paste-like
    // event rather than three keypresses.
    view.stdin.write('\u001b[B\u001b[B\u001b[B');

    expect(seen).toEqual([1, 2, 3]);
  });

  it('renders the value it was given', async () => {
    function Probe() {
      const [value, setValue, current] = useKeyState('target');
      useInput(() => setValue(current() === 'target' ? 'action' : 'target'));
      return <Text>{value}</Text>;
    }

    const view = render(<Probe />);
    expect(view.lastFrame()).toContain('target');

    view.stdin.write('\u001b[B');
    // The ref moves inside the handler; the frame catches up on the next render.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('action');
  });

  it('accepts a lazy initial value like useState does', () => {
    function Probe() {
      const [value] = useKeyState(() => 'computed');
      return <Text>{value}</Text>;
    }

    expect(render(<Probe />).lastFrame()).toContain('computed');
  });
});
