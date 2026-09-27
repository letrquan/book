import { act, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { TextInputField, type TextInputFieldProps } from './TextInputField.js';

/** The field with its value fed back the way every call site does it. */
function Harness({
  onReport,
  initial = '',
  fieldProps = {},
}: {
  onReport?: (value: string) => void;
  initial?: string;
  fieldProps?: Partial<TextInputFieldProps>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TextInputField
      value={value}
      onChange={(next) => {
        setValue(next);
        onReport?.(next);
      }}
      {...fieldProps}
    />
  );
}

// One stdin chunk, rendered before the next arrives. Inside `act`, React commits
// this chunk's updates and re-binds Ink's input handlers before `write` resolves,
// so the next key reaches the handler for the value this key produced. A fixed
// sleep between keys is what made these flake: it buys time rather than
// correctness, and a loaded runner outlasts it.
async function press(view: ReturnType<typeof render>, input: string) {
  await act(async () => {
    view.stdin.write(input);
  });
}

const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const HOME = '\x1b[H';
const END = '\x1b[F';
const BACKSPACE = '\x7f';
const DELETE = '\x1b[3~';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const CTRL_U = '\x15';
const CTRL_K = '\x0b';
const CTRL_W = '\x17';
const CTRL_D = '\x04';

/** A field, a record of every value it reported, and a read of the latest. */
function mount(initial = '') {
  const seen: string[] = [];
  const view = render(<Harness onReport={(next) => seen.push(next)} initial={initial} />);
  return {
    view,
    seen,
    // A function, not a getter: a destructured getter is a snapshot of the
    // value at destructuring time, which is the field's value before any key.
    value: () => seen[seen.length - 1] ?? initial,
  };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (view: ReturnType<typeof render>) => (view.lastFrame() ?? '').replace(ANSI, '');

afterEach(cleanup);

describe('TextInputField', () => {
  it('drops mouse reports instead of typing them into the value', async () => {
    const { view, value } = mount();

    await press(view, 'https://api.example.com/v1');
    await press(view, '\x1b[<0;12;4M');
    await press(view, '\x1b[<0;12;4m');

    expect(value()).toBe('https://api.example.com/v1');
  });

  it('keeps the cursor on the value after dropping a report', async () => {
    const { view, value } = mount();

    await press(view, 'hello');
    await press(view, '\x1b[<0;12;4M');
    await press(view, 'X');
    expect(value()).toBe('helloX');

    // Backspace deletes the character just typed. `ink-text-input` advanced its
    // cursor by the length of the report and re-clamped it only when the value
    // prop changed, so the delete landed at a stale offset and yielded 'hellX'.
    await press(view, BACKSPACE);
    expect(value()).toBe('hello');
  });

  // The bug that ended the dependency: Ink delivers one stdin chunk to every
  // handler in turn, so a wrapper that cleared the value in response to Ctrl+U
  // still lost the race — after a Left, the inner component re-subscribed and
  // inserted its `u` after the clear.
  it('kills only to the cursor when Ctrl+U follows a Left', async () => {
    const { view, value } = mount('https://abc.example/v1');

    await press(view, LEFT);
    await press(view, LEFT);
    await press(view, CTRL_U);

    // Ctrl+U kills what is *behind* the cursor, so the tail survives: that is
    // what distinguishes a kill-to-cursor from clearing the field. And no `u`
    // was typed, which is the letter this chord used to arrive as.
    expect(value()).toBe('v1');
    expect(value()).not.toContain('u');

    // Mid-line it is the same edit: behind the cursor goes, ahead of it stays.
    const middle = mount('abc');
    await press(middle.view, LEFT);
    await press(middle.view, CTRL_U);
    expect(middle.value()).toBe('c');
  });

  it('kills the word to the left on Ctrl+W', async () => {
    const { view, value } = mount('one two three');

    await press(view, CTRL_W);
    expect(value()).toBe('one two ');

    await press(view, CTRL_W);
    expect(value()).toBe('one ');
  });

  it('kills to the end of the line on Ctrl+K', async () => {
    const { view, value } = mount('keep this gone');

    await press(view, HOME);
    await press(view, RIGHT);
    await press(view, RIGHT);
    await press(view, RIGHT);
    await press(view, RIGHT);
    await press(view, CTRL_K);

    expect(value()).toBe('keep');
  });

  it('moves the cursor home and to the end on Ctrl+A and Ctrl+E', async () => {
    const { view, value } = mount('abc');

    await press(view, CTRL_A);
    await press(view, 'X');
    expect(value()).toBe('Xabc');

    await press(view, CTRL_E);
    await press(view, 'Y');
    expect(value()).toBe('XabcY');
  });

  it('deletes the character under the cursor on Ctrl+D', async () => {
    const { view, value } = mount('abc');

    await press(view, HOME);
    await press(view, CTRL_D);
    expect(value()).toBe('bc');
  });

  it('ignores a Ctrl chord it does not implement rather than typing its letter', async () => {
    // Every chord reaches a field as the bare letter it stands for, so the ones
    // with no edit must end the key instead of falling through to insert.
    for (const [chord, letter] of [
      [CTRL_U, 'u'],
      [CTRL_W, 'w'],
      [CTRL_K, 'k'],
      [CTRL_A, 'a'],
      [CTRL_E, 'e'],
      [CTRL_D, 'd'],
    ] as const) {
      const { view, value } = mount();
      await press(view, chord);
      expect(value).not.toContain(letter);
      expect(value()).toBe('');
    }

    // A chord with no edit at all: Ctrl+R is nothing this editor does.
    const { view, value } = mount('abc');
    await press(view, '\x12');
    expect(value()).toBe('abc');
  });

  it('moves and deletes by grapheme, not by code unit', async () => {
    const { view, value } = mount('éx');

    // `é` is one grapheme of two code units. Stepping left from the end lands
    // between the two units' characters but before the grapheme, and one
    // Backspace then takes the whole letter rather than half of it.
    await press(view, LEFT);
    await press(view, BACKSPACE);
    expect(value()).toBe('x');

    await press(view, HOME);
    await press(view, DELETE);
    expect(value()).toBe('');

    await press(view, END);
    await press(view, RIGHT);
    await press(view, BACKSPACE);
    expect(value()).toBe('');
  });

  it('masks the value and edits the value behind the mask', async () => {
    const seen: string[] = [];
    const view = render(
      <Harness onReport={(next) => seen.push(next)} fieldProps={{ mask: '•' }} />,
    );

    await press(view, 'sk secret');
    // Eleven characters, eleven masks, and the real value nowhere in the frame.
    expect(plain(view).replaceAll('•', '').trim()).toBe('');

    // The mask is a rendering, not the value: the chords edit what is behind it,
    // and Ctrl+W kills the one word, not the whole field.
    await press(view, CTRL_W);
    expect(seen[seen.length - 1]).toBe('sk ');
    expect(plain(view).replaceAll('•', '').trim()).toBe('');
  });

  it('inserts a pasted chunk whole', async () => {
    const { view, value } = mount('a');
    await press(view, CTRL_A);
    await press(view, 'bcdef');
    // One stdin chunk, inserted at the cursor as a unit rather than six keys.
    expect(value()).toBe('bcdefa');
  });

  it('shows the placeholder when empty and the value once there is one', async () => {
    const view = render(<Harness fieldProps={{ placeholder: 'Write your own answer' }} />);

    expect(plain(view)).toContain('Write your own answer');
    await press(view, 'hi');
    expect(plain(view)).toContain('hi');
    expect(plain(view)).not.toContain('Write your own answer');
  });
});
