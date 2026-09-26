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
});
