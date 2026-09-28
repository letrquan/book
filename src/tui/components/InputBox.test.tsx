import { cleanup, render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBox } from './InputBox.js';

afterEach(() => cleanup());

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Feeds each edit back as the new value, the way InputBar does. */
function Harness({
  initial,
  onBackspaceWhenEmpty,
  onEmptyChord,
  onChange,
}: {
  initial: string;
  onBackspaceWhenEmpty?: () => void;
  onEmptyChord?: () => void;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <InputBox
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      onBackspaceWhenEmpty={onBackspaceWhenEmpty}
      onEmptyChord={onEmptyChord}
    />
  );
}

const BACKSPACE = '\x7f';

describe('InputBox', () => {
  it('reports Backspace on an empty composer instead of editing', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <Harness initial="" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await sleep(30);

    view.stdin.write(BACKSPACE);
    await vi.waitFor(() => expect(onBackspaceWhenEmpty).toHaveBeenCalledOnce());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('deletes the last character without reporting an empty composer', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <Harness initial="a" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await sleep(30);

    view.stdin.write(BACKSPACE);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
    await sleep(250);
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
  });

  it('removes nothing when repeats in one read empty the composer', async () => {
    const onChange = vi.fn();
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(
      <Harness initial="ab" onChange={onChange} onBackspaceWhenEmpty={onBackspaceWhenEmpty} />,
    );
    await sleep(30);

    view.stdin.write(BACKSPACE.repeat(4));
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith(''));
    await sleep(250);
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
  });

  it('removes nothing when a held Backspace empties the composer across the repeat delay', async () => {
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(<Harness initial="a" onBackspaceWhenEmpty={onBackspaceWhenEmpty} />);
    await sleep(30);

    // Press, the key-repeat delay, then repeats every ~35 ms.
    view.stdin.write(BACKSPACE);
    await sleep(400);
    view.stdin.write(BACKSPACE);
    await sleep(35);
    view.stdin.write(BACKSPACE);
    await sleep(35);
    view.stdin.write(BACKSPACE);
    await sleep(250);
    expect(onBackspaceWhenEmpty).not.toHaveBeenCalled();
  });

  it('removes exactly one attachment for a Backspace held on an empty composer', async () => {
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(<Harness initial="" onBackspaceWhenEmpty={onBackspaceWhenEmpty} />);
    await sleep(30);

    view.stdin.write(BACKSPACE);
    await sleep(400);
    view.stdin.write(BACKSPACE);
    await sleep(35);
    view.stdin.write(BACKSPACE);
    await sleep(250);
    expect(onBackspaceWhenEmpty).toHaveBeenCalledOnce();
  });

  it('removes one attachment per deliberate tap', async () => {
    const onBackspaceWhenEmpty = vi.fn();
    const view = render(<Harness initial="" onBackspaceWhenEmpty={onBackspaceWhenEmpty} />);
    await sleep(30);

    view.stdin.write(BACKSPACE);
    await sleep(250);
    view.stdin.write(BACKSPACE);
    await sleep(250);
    expect(onBackspaceWhenEmpty).toHaveBeenCalledTimes(2);
  });

  it('deletes the character after the cursor with the Delete key', async () => {
    const onChange = vi.fn();
    const view = render(<Harness initial="abc" onChange={onChange} />);
    await sleep(30);

    view.stdin.write('\x1b[D');
    await sleep(30);
    view.stdin.write('\x1b[D');
    await sleep(30);
    view.stdin.write('\x1b[3~');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('ac'));
  });

  it('deletes the word after the cursor with Alt+Delete', async () => {
    const onChange = vi.fn();
    const view = render(<Harness initial="foo bar baz" onChange={onChange} />);
    await sleep(30);

    view.stdin.write('\x1b[H');
    await sleep(30);
    for (let index = 0; index < 4; index += 1) {
      view.stdin.write('\x1b[C');
      await sleep(30);
    }
    view.stdin.write('\x1b[3;3~');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('foo  baz'));
  });

  // Ctrl+U and Ctrl+D are the pager's half-page chords. The transcript can only
  // read them as a scroll when the composer had nothing to edit, and it cannot
  // tell that for itself: Ctrl+U empties the field before any other handler
  // runs. So the composer reports an empty-draft chord itself, and a draft in
  // hand ends the key here.
  it('hands Ctrl+U and Ctrl+D to the transcript only on an empty draft', async () => {
    const onEmptyChord = vi.fn();
    const onChange = vi.fn();
    const view = render(<Harness initial="" onChange={onChange} onEmptyChord={onEmptyChord} />);
    await sleep(30);

    view.stdin.write('\x15'); // Ctrl+U
    await vi.waitFor(() => expect(onEmptyChord).toHaveBeenCalledOnce());
    view.stdin.write('\x04'); // Ctrl+D
    await vi.waitFor(() => expect(onEmptyChord).toHaveBeenCalledTimes(2));
    expect(onChange).not.toHaveBeenCalled();

    // A draft in hand: Ctrl+U clears it and Ctrl+D does nothing, and neither
    // is the transcript's.
    view.stdin.write('second draft');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('second draft'));
    onEmptyChord.mockClear();
    onChange.mockClear();

    view.stdin.write('\x15'); // Ctrl+U
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
    expect(onEmptyChord).not.toHaveBeenCalled();

    view.stdin.write('second draft');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith('second draft'));
    onEmptyChord.mockClear();
    onChange.mockClear();

    view.stdin.write('\x04'); // Ctrl+D
    await sleep(30);
    expect(onEmptyChord).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a mouse wheel report: no edit, and the cursor stays where it was', async () => {
    const onChange = vi.fn();
    const view = render(<Harness initial="abc" onChange={onChange} />);
    await sleep(30);

    view.stdin.write('\x1b[D');
    await sleep(20);
    view.stdin.write('\x1b[D');
    await sleep(20);
    view.stdin.write('\x1b[<64;40;20M');
    await sleep(30);
    expect(onChange).not.toHaveBeenCalled();

    view.stdin.write('X');
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('aXbc'));
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('keeps typed text that arrives in the same read as a mouse report', async () => {
    const onChange = vi.fn();
    const view = render(<Harness initial="" onChange={onChange} />);
    await sleep(30);

    view.stdin.write('a\x1b[<65;40;20Mb');
    await vi.waitFor(() => expect(onChange).toHaveBeenLastCalledWith('ab'));
  });
});
