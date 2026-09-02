import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { setTimeout as wait } from 'node:timers/promises';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { ListPicker, type ListPickerItem } from './ListPicker.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function items(count: number): ListPickerItem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row-${index}`,
    label: `row ${index}`,
  }));
}

function mount(props: Partial<React.ComponentProps<typeof ListPicker>> = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ListPicker
        title="Pick one"
        items={items(4)}
        enterHint="save"
        onSelect={onSelect}
        onCancel={onCancel}
        {...props}
      />
    </ThemeContext.Provider>,
  );
  return { view, onSelect, onCancel };
}

async function press(view: ReturnType<typeof render>, input: string) {
  view.stdin.write(input);
  await wait(20);
}

afterEach(cleanup);

describe('ListPicker', () => {
  it('selects the row the cursor is on, and cancels on Esc', async () => {
    const { view, onSelect, onCancel } = mount();

    await press(view, '\u001b[B\u001b[B');
    await press(view, '\r');
    expect(onSelect).toHaveBeenCalledWith(2);

    await press(view, '\u001b');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('acts on the row an arrow reached in the same batch', async () => {
    // One write. Ink splits a chunk only at escape bytes, so this is two real
    // keypresses inside one React batch — the case #165 was about. Every
    // adopter inherits it from the shared cursor rather than remembering it.
    const { view, onSelect } = mount();

    await press(view, '\u001b[B\r');

    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('windows a list longer than the view instead of dropping the overflow', async () => {
    // SessionPicker used to render a hard `slice(0, 12)` while wrapping its
    // cursor over every session, so past the twelfth nothing was highlighted
    // and Enter resumed a conversation that had never been drawn.
    const { view, onSelect } = mount({ items: items(30), maxVisible: 5 });
    expect(stripAnsi(view.lastFrame())).toContain('+25 more');

    for (let i = 0; i < 20; i++) await press(view, '\u001b[B');
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('row 20');

    await press(view, '\r');
    expect(onSelect).toHaveBeenCalledWith(20);
  });

  it('pages with PgDn/PgUp and clamps at both ends', async () => {
    const { view, onSelect } = mount({ items: items(30), maxVisible: 5 });

    await press(view, '\u001b[6~');
    await press(view, '\u001b[6~');
    await press(view, '\r');
    expect(onSelect).toHaveBeenLastCalledWith(10);

    // Clamps rather than wrapping: the end of a long list is a destination.
    for (let i = 0; i < 10; i++) await press(view, '\u001b[6~');
    await press(view, '\r');
    expect(onSelect).toHaveBeenLastCalledWith(29);

    for (let i = 0; i < 10; i++) await press(view, '\u001b[5~');
    await press(view, '\r');
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it('filters only when asked, and reports the index in the original list', async () => {
    const { view, onSelect } = mount({ items: items(30), maxVisible: 5, filterable: true });

    await press(view, '2');
    await press(view, '3');
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain('filter: 23');
    expect(frame).toContain('row 23');

    await press(view, '\r');
    expect(onSelect).toHaveBeenCalledWith(23);
  });

  it('leaves a typed key alone when filtering is off', async () => {
    const { view, onSelect } = mount();

    await press(view, 'r');
    expect(stripAnsi(view.lastFrame())).not.toContain('filter:');

    await press(view, '\r');
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('refuses a disabled row and says so in the hint line', async () => {
    const { view, onSelect } = mount({
      items: [
        { key: 'a', label: 'Available' },
        { key: 'b', label: 'Blocked', disabled: true, note: '(unavailable)' },
      ],
    });

    await press(view, '\u001b[B\r');
    expect(onSelect).not.toHaveBeenCalled();
    expect(stripAnsi(view.lastFrame())).toContain('(unavailable)');
  });

  it('offers component keys before its own, with a batch-safe index', async () => {
    const seen: number[] = [];
    const { view } = mount({
      onKey: (input, _key, index) => {
        if (input !== 'r') return false;
        seen.push(index);
        return true;
      },
    });

    await press(view, '\u001b[B\u001b[B');
    await press(view, 'r');
    expect(seen).toEqual([2]);
  });

  it('takes no keys while inactive', async () => {
    const { view, onSelect, onCancel } = mount({ isActive: false });

    await press(view, '\r');
    await press(view, '\u001b');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('names one verb for Esc unless the caller means something else by it', () => {
    expect(stripAnsi(mount().view.lastFrame())).toContain('Esc close');
    cleanup();
    expect(stripAnsi(mount({ escHint: 'back' }).view.lastFrame())).toContain('Esc back');
  });
});
