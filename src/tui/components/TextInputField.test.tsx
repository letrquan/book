import { setTimeout as wait } from 'node:timers/promises';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { TextInputField } from './TextInputField.js';

function Harness({ report }: { report: (value: string) => void }) {
  const [value, setValue] = useState('');
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
});
