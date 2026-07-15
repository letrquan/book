import { Box, Text } from 'ink';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { TranscriptView } from './TranscriptView.js';

function Rows({ labels }: { labels: string[] }) {
  return (
    <Box flexDirection="column">
      {labels.map((label) => (
        <Text key={label}>{label}</Text>
      ))}
    </Box>
  );
}

function view(
  labels: string[],
  props: { height?: number; isActive?: boolean; followRequestKey?: number } = {},
) {
  return (
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <TranscriptView
        height={props.height ?? 5}
        width={20}
        isActive={props.isActive}
        followRequestKey={props.followRequestKey}
      >
        <Rows labels={labels} />
      </TranscriptView>
    </ThemeContext.Provider>
  );
}

const frameLines = (frame: string | undefined) => (frame ?? '').split('\n').filter(Boolean);

describe('TranscriptView', () => {
  it('clips to the latest rendered rows initially', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);
  });

  it('scrolls through measured rows with PageUp and PageDown', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));

    act(() => app.stdin.write('[5~'));
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F']));
    const older = frameLines(app.lastFrame());
    expect(older.some((line) => line.includes('browsing history'))).toBe(true);
    expect(older).toContain('A');
    expect(older).toContain('B');

    act(() => app.stdin.write('[6~'));
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F']));
    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);
  });

  it('scrolls with SGR mouse wheel reports', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    const older = frameLines(app.lastFrame());
    expect(older.some((line) => line.includes('browsing history'))).toBe(true);
    expect(older).toContain('B');
    expect(older).not.toContain('H');

    act(() => app.stdin.write('\x1b[<65;10;5M'));
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    expect(frameLines(app.lastFrame())).toEqual(['E', 'F', 'G', 'H']);
  });

  it('ignores mouse clicks and wheel reports while inactive', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    const app = render(view(labels));

    act(() => app.stdin.write('\x1b[<0;10;5M'));
    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);

    app.rerender(view(labels, { isActive: false }));
    act(() => app.stdin.write('\x1b[<64;10;5M'));
    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);
  });

  it('follows appended output while pinned to the tail', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G']));
    expect(frameLines(app.lastFrame())).toEqual(['D', 'E', 'F', 'G']);
  });

  it('keeps manual history stable while new output arrives', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    act(() => app.stdin.write('[5~'));

    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G']));
    const lines = frameLines(app.lastFrame());
    expect(lines.some((line) => line.includes('new output below'))).toBe(true);
    expect(lines).toContain('B');
    expect(lines).not.toContain('G');
  });

  it('reconciles height changes in follow mode', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    const app = render(view(labels));
    app.rerender(view(labels, { height: 4 }));
    expect(frameLines(app.lastFrame())).toEqual(['D', 'E', 'F']);
    app.rerender(view(labels, { height: 6 }));
    expect(frameLines(app.lastFrame())).toEqual(['B', 'C', 'D', 'E', 'F']);
  });

  it('ignores navigation when inactive', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { isActive: false }));
    act(() => app.stdin.write('[5~'));
    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);
  });
});
