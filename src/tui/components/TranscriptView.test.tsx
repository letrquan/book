import { Box, Text } from 'ink';
import { act, Profiler } from 'react';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { TranscriptView } from './TranscriptView.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ChatPanel } from './ChatPanel.js';
import { toolSuccess } from '../../tools/result.js';
import type { Message } from '../../types/messages.js';
import { useTranscriptHistoryLoader, type TranscriptHistoryLoader } from '../transcript-layout.js';

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
    onToggleTool?: (toolId: string) => void;
  } = {},
) {
  return (
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <TranscriptView
        height={props.height ?? 5}
        width={20}
        isActive={props.isActive}
        followRequestKey={props.followRequestKey}
        onToggleTool={props.onToggleTool}
      >
        <Rows labels={labels} />
      </TranscriptView>
    </ThemeContext.Provider>
  );
}

const frameLines = (frame: string | undefined) => (frame ?? '').split('\n').filter(Boolean);

async function flushWheelFrame(): Promise<void> {
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

  it('scrolls three rows per SGR mouse wheel report', async () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushWheelFrame();
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    const older = frameLines(app.lastFrame());
    expect(older.some((line) => line.includes('browsing history'))).toBe(true);
    expect(older).toContain('B');
    expect(older).not.toContain('H');

    act(() => app.stdin.write('\x1b[<65;10;5M'));
    await flushWheelFrame();
    app.rerender(view(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']));
    expect(frameLines(app.lastFrame())).toEqual(['E', 'F', 'G', 'H']);
  });

  it('coalesces rapid wheel reports without dropping a terminal input chunk', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels));

    act(() => {
      app.stdin.write('\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M');
    });
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toContain('A');
  });

  it('coalesces separate wheel chunks in the same event-loop turn', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels));

    act(() => {
      app.stdin.write('\x1b[<64;10;5M');
      app.stdin.write('\x1b[<64;10;5M');
    });
    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toContain('A');
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

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushWheelFrame();
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

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushWheelFrame();
    const browsingCommitCount = commitCount;
    expect(browsingCommitCount).toBeGreaterThan(1);

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushWheelFrame();
    expect(commitCount).toBeGreaterThan(browsingCommitCount);
    expect(childRenderCount).toBe(1);
    expect(frameLines(app.lastFrame())).toContain('D');
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

  it('cancels opposite wheel reports within the same render turn', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels));

    act(() => {
      app.stdin.write('\x1b[<64;10;5M');
      app.stdin.write('\x1b[<65;10;5M');
    });
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);
  });

  it('keeps queued wheel scrolling stable when the tool callback changes', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels, { onToggleTool: vi.fn() }));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    app.rerender(view(labels, { onToggleTool: vi.fn() }));
    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toContain('A');
  });

  it('cancels queued wheel rows when follow-bottom is requested', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels, { followRequestKey: 0 }));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    app.rerender(view(labels, { followRequestKey: 1 }));
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);
  });

  it('cancels queued wheel rows before keyboard navigation', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    const app = render(view(labels));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    act(() => app.stdin.write('\x1b[6~'));
    await flushWheelFrame();
    expect(frameLines(app.lastFrame())).toEqual(['G', 'H', 'I', 'J']);
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

  it('toggles only expandable tool summary rows on left-button presses', () => {
    const onToggleTool = vi.fn();
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          <ToolCallBlock
            toolId="tool-1"
            name="Bash"
            args={{ command: 'npm test' }}
            result={toolSuccess('passed', { toolCallId: 'tool-1' })}
            isExpanded={false}
            terminalWidth={60}
            reducedMotion
          />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    act(() => app.stdin.write('\x1b[<0;4;2M'));
    expect(onToggleTool).toHaveBeenCalledWith('tool-1');

    act(() => app.stdin.write('\x1b[<0;4;2m'));
    act(() => app.stdin.write('\x1b[<32;4;2M'));
    act(() => app.stdin.write('\x1b[<0;4;5M'));
    expect(onToggleTool).toHaveBeenCalledTimes(1);
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
