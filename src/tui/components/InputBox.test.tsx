import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBox } from './InputBox.js';

afterEach(() => cleanup());

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('InputBox', () => {
  it('reports Backspace on an empty composer instead of editing', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <InputBox value="" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await settle();

    view.stdin.write('\x7f');
    await vi.waitFor(() => expect(onBackspaceWhenEmpty).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes the last character without reporting an empty composer', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <InputBox value="a" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await settle();

    view.stdin.write('\x7f');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
  });

  it('does not report Backspace repeats that emptied the composer', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <InputBox value="ab" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await settle();

    // A held key: four repeats in one read. Two delete the text, two land on the empty composer.
    view.stdin.write('\x7f\x7f\x7f\x7f');
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(''));
    await settle();
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
  });

  it('reports a fresh Backspace press on the empty composer', async () => {
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <InputBox value="a" onChange={() => {}} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await settle();

    view.stdin.write('\x7f');
    await settle();
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
    // The composer is empty now, which is the state the parent would have committed.
    view.rerender(
      <InputBox value="" onChange={() => {}} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 250));
    view.stdin.write('\x7f');
    await vi.waitFor(() => expect(onBackspaceWhenEmpty).toHaveBeenCalledOnce());
  });

  it('deletes the character after the cursor with the Delete key', async () => {
    const onChange = vi.fn();
    const view = render(<InputBox value="abc" onChange={onChange} />);
    await settle();

    view.stdin.write('\x1b[D');
    await settle();
    view.stdin.write('\x1b[D');
    await settle();
    view.stdin.write('\x1b[3~');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('ac'));
  });
});
