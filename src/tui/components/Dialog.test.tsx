import { afterEach, describe, expect, it } from 'vitest';
import { Box, Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { frameGrid } from '../layout.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { Dialog, DIALOG_CHROME_ROWS, DIALOG_EDGE } from './Dialog.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

function lines(count: number) {
  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, index) => (
        <Text key={index}>{`row ${index + 1}`}</Text>
      ))}
    </Box>
  );
}

function show(
  body: React.ReactElement,
  {
    maxBodyRows = 10,
    width = 60,
    meta,
    screenReader = false,
  }: { maxBodyRows?: number; width?: number; meta?: string; screenReader?: boolean } = {},
) {
  const view = render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <Dialog
        title="Cost"
        meta={meta}
        terminalWidth={width}
        maxBodyRows={maxBodyRows}
        screenReader={screenReader}
      >
        {body}
      </Dialog>
    </ThemeContext.Provider>,
  );
  return { view, frame: () => stripAnsi(view.lastFrame()).split('\n') };
}

afterEach(() => cleanup());

describe('Dialog', () => {
  it('hangs from an edge across the screen, with the title, the body and the keys under it', async () => {
    const { frame } = show(<Text>120 tokens (100 in, 20 out)</Text>);
    await settle();
    const [edge, title, gap, body, air, keys] = frame();
    // As wide as the composer it stands in for.
    expect(edge).toBe(DIALOG_EDGE.repeat(frameGrid(60).width));
    expect(displayWidth(edge!)).toBe(frameGrid(60).width);
    expect(title?.trim()).toBe('§ Cost');
    expect(gap?.trim()).toBe('');
    expect(body?.trim()).toBe('120 tokens (100 in, 20 out)');
    expect(air?.trim()).toBe('');
    expect(keys?.trim()).toBe('Esc to close');
    // Title, body and keys share one column.
    expect(title?.indexOf('§')).toBe(body?.indexOf('1'));
    expect(keys?.indexOf('E')).toBe(body?.indexOf('1'));
    expect(frame().filter((line) => line.trim()).length).toBe(DIALOG_CHROME_ROWS - 2 + 1);
  });

  it('sets a note at the far end of the title row', async () => {
    const { frame } = show(<Text>body</Text>, { meta: '42 commands' });
    await settle();
    expect(frame()[1]).toMatch(/^ {2}§ Cost +42 commands$/);
  });

  it('opens a tall body at its top and scrolls it inside the dialog', async () => {
    const { view, frame } = show(lines(30), { maxBodyRows: 5 });
    await settle();
    let shown = frame();
    expect(shown.filter((line) => line.includes('row ')).map((line) => line.trim())).toEqual([
      'row 1',
      'row 2',
      'row 3',
      'row 4',
      'row 5',
    ]);
    expect(shown.at(-1)?.trim()).toBe('↑/↓ to scroll · Esc to close');

    view.stdin.write('\x1b[B');
    await settle();
    shown = frame();
    expect(shown.find((line) => line.includes('row '))?.trim()).toBe('row 2');

    view.stdin.write('\x1b[F'); // End
    await settle();
    shown = frame();
    expect(
      shown
        .filter((line) => line.includes('row '))
        .at(-1)
        ?.trim(),
    ).toBe('row 30');
    // The keys are still the last row: a tall body never pushes them off.
    expect(shown.at(-1)?.trim()).toBe('↑/↓ to scroll · Esc to close');
  });

  it('says only Esc when the body fits', async () => {
    const { frame } = show(lines(3), { maxBodyRows: 5 });
    await settle();
    expect(frame().at(-1)?.trim()).toBe('Esc to close');
  });

  it('reads plainly for a screen reader', async () => {
    const { frame } = show(<Text>120 tokens</Text>, { screenReader: true, meta: '3 rows' });
    await settle();
    const text = frame().join('\n');
    expect(text).not.toContain(DIALOG_EDGE);
    expect(text).toContain('Cost · 3 rows');
    expect(text).toContain('120 tokens');
    expect(text).toContain('Esc to close');
  });
});
