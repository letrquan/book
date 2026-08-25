import { Box, Text } from 'ink';
import { act, Profiler } from 'react';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { TranscriptView } from './TranscriptView.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ChatPanel } from './ChatPanel.js';
import type { Message } from '../../types/messages.js';
import { useTranscriptHistoryLoader, type TranscriptHistoryLoader } from '../transcript-layout.js';

const { setTranscriptScrollHintSpy } = vi.hoisted(() => ({
  setTranscriptScrollHintSpy: vi.fn(),
}));

vi.mock('../ink-scroll-renderer.js', () => ({
  setTranscriptScrollHint: setTranscriptScrollHintSpy,
}));

function Rows({ labels }: { labels: string[] }) {
  return (
    <Box flexDirection="column">
      {labels.map((label) => (
        <Text key={label}>{label}</Text>
      ))}
    </Box>
  );
}

function HistoryRows({ labels, onLoad }: { labels: string[]; onLoad: TranscriptHistoryLoader }) {
  useTranscriptHistoryLoader(onLoad);
  return <Rows labels={labels} />;
}

function view(
  labels: string[],
  props: {
    height?: number;
    isActive?: boolean;
    followRequestKey?: number;
    layoutRevision?: unknown;
  } = {},
) {
  return (
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <TranscriptView
        height={props.height ?? 5}
        width={20}
        isActive={props.isActive}
        followRequestKey={props.followRequestKey}
        layoutRevision={props.layoutRevision}
      >
        <Rows labels={labels} />
      </TranscriptView>
    </ThemeContext.Provider>
  );
}

const frameLines = (frame: string | undefined) => (frame ?? '').split('\n').filter(Boolean);

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

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

  it('loads another history page when Ctrl+U is pressed at the hydrated start', () => {
    const onLoad = vi.fn<TranscriptHistoryLoader>(() => true);
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={5} width={20}>
          <HistoryRows labels={labels} onLoad={onLoad} />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    for (let index = 0; index < 4; index++) {
      act(() => app.stdin.write('\x15'));
    }

    expect(onLoad).toHaveBeenCalledWith('page');
  });

  it('publishes scroll hints for consecutive transcript-only scrolls', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    setTranscriptScrollHintSpy.mockClear();

    act(() => app.stdin.write('\x15'));
    act(() => app.stdin.write('\x15'));

    expect(setTranscriptScrollHintSpy).toHaveBeenCalledWith(expect.objectContaining({ delta: -2 }));
  });

  it('does not re-render transcript children for scroll-only updates', async () => {
    let childRenderCount = 0;
    function CountingRows() {
      childRenderCount++;
      return <Rows labels={['A', 'B', 'C', 'D', 'E', 'F']} />;
    }
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={5} width={20}>
          <CountingRows />
        </TranscriptView>
      </ThemeContext.Provider>,
    );
    expect(childRenderCount).toBe(1);

    act(() => app.stdin.write('\x15'));
    expect(childRenderCount).toBe(1);
  });

  it('routes each scroll update through React without re-rendering transcript children', async () => {
    let commitCount = 0;
    let childRenderCount = 0;
    function CountingRows() {
      childRenderCount++;
      return <Rows labels={['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']} />;
    }
    const app = render(
      <Profiler id="transcript" onRender={() => commitCount++}>
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <TranscriptView height={5} width={20}>
            <CountingRows />
          </TranscriptView>
        </ThemeContext.Provider>
      </Profiler>,
    );

    act(() => app.stdin.write('\x15'));
    const browsingCommitCount = commitCount;
    expect(browsingCommitCount).toBeGreaterThan(1);

    act(() => app.stdin.write('\x15'));
    expect(commitCount).toBeGreaterThan(browsingCommitCount);
    expect(childRenderCount).toBe(1);
    expect(frameLines(app.lastFrame())).toContain('E');
  });

  it('reconciles content height after a descendant-local markdown update', async () => {
    let grow: (() => void) | undefined;
    function GrowingMarkdown() {
      const [content, setContent] = useState('initial line');
      grow = () =>
        setContent(Array.from({ length: 12 }, (_, index) => `grown line ${index + 1}`).join('\n'));
      return <MarkdownBlock content={content} terminalWidth={20} />;
    }

    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={5} width={20}>
          <GrowingMarkdown />
        </TranscriptView>
      </ThemeContext.Provider>,
    );
    expect(grow).toBeDefined();

    act(() => grow?.());
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(frameLines(app.lastFrame())).toContain('grown line 12');
  });

  it('reconciles structural child changes when the layout revision advances', () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { layoutRevision: 0 }));

    app.rerender(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={5} width={20} layoutRevision={1}>
          <Rows labels={['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']} />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);

    act(() => app.stdin.write('\x1b[1;5H'));
    expect(frameLines(app.lastFrame())).toContain('A');
  });

  it('returns to the tail when follow-bottom is requested', () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels, { followRequestKey: 0 }));

    act(() => app.stdin.write('\x15'));
    app.rerender(view(labels, { followRequestKey: 1 }));
    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);
  });

  it('ignores mouse reports, which Book never asks the terminal to send', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    const app = render(view(labels));

    // Wheel up, wheel down, left press, drag, and release, as a terminal left in
    // a tracking mode by another program would report them.
    for (const report of [
      '\x1b[<64;10;5M',
      '\x1b[<65;10;5M',
      '\x1b[<0;4;2M',
      '\x1b[<32;4;2M',
      '\x1b[<0;4;2m',
    ]) {
      act(() => app.stdin.write(report));
    }
    await flushFrame();

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

  it('loads bounded completed history before jumping to the transcript start', async () => {
    const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `entry-${index}`,
      includeInContext: true,
      timestamp: index,
    }));
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={8} width={80}>
          <ChatPanel messages={messages} terminalWidth={80} terminalHeight={24} reducedMotion />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    expect(app.lastFrame()).not.toContain('entry-0');
    await act(async () => {
      app.stdin.write('\x1b[1;5H');
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(app.lastFrame()).toContain('entry-0');

    act(() => app.stdin.write('\x1b[1;5F'));
    expect(app.lastFrame()).toContain('entry-199');
  });
});
