import { setTimeout as wait } from 'node:timers/promises';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { TextInputField } from './TextInputField.js';

function Harness({ report, initial = '' }: { report: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <TextInputField
      value={value}
      onChange={(next) => {
        setValue(next);
        report(next);
      }}
    />
  );
}

async function type(view: ReturnType<typeof render>, input: string) {
  view.stdin.write(input);
  await wait(20);
}

afterEach(cleanup);

describe('TextInputField', () => {
  it('drops mouse reports instead of typing them into the value', async () => {
    let value = '';
    const view = render(<Harness report={(next) => (value = next)} />);

    await type(view, 'https://api.example.com/v1');
    await type(view, '\x1b[<0;12;4M');
    await type(view, '\x1b[<0;12;4m');

    expect(value).toBe('https://api.example.com/v1');
  });

  it('keeps the cursor on the value after dropping a report', async () => {
    let value = '';
    const view = render(<Harness report={(next) => (value = next)} />);

    await type(view, 'hello');
    await type(view, '\x1b[<0;12;4M');
    await type(view, 'X');
    expect(value).toBe('helloX');

    // Backspace must delete the character just typed. Without re-seating the
    // cursor after the strip it deletes at the stale offset and yields 'hellX'.
    await type(view, '\x7f');
    expect(value).toBe('hello');
  });

  it('kills the text before the cursor on Ctrl+U instead of typing a u', async () => {
    let value = '';
    const view = render(
      <Harness report={(next) => (value = next)} initial="https://api.openai.com/v1" />,
    );

    await type(view, '\x15');

    // The prefilled base URL is gone and no `u` was typed in its place: the
    // wizard's field used to answer the readline chord by becoming "u".
    expect(value).not.toContain('u');
    expect(value).toBe('');
  });

  it('keeps the other Ctrl chords as they were', async () => {
    let value = '';
    const view = render(<Harness report={(next) => (value = next)} initial="abc" />);

    // Only Ctrl+U is taken here. Ctrl+A still reaches the field and inserts
    // the letter it carries, as it always has.
    await type(view, '\x01');
    expect(value).toBe('abca');
  });
});
