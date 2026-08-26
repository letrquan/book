import { Box, Text } from 'ink';
import { act, Profiler } from 'react';
import { useState } from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { TranscriptView } from './TranscriptView.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ChatPanel } from './ChatPanel.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { toolSuccess } from '../../tools/result.js';
import type { Message } from '../../types/messages.js';
import { useTranscriptHistoryLoader, type TranscriptHistoryLoader } from '../transcript-layout.js';
import { setFrameSnapshotForTesting } from '../frame-buffer.js';

const { setTranscriptScrollHintSpy, writeClipboardMock } = vi.hoisted(() => ({
  setTranscriptScrollHintSpy: vi.fn(),
  writeClipboardMock: vi.fn<(text: string) => Promise<'clipboard' | 'terminal' | 'failed'>>(),
}));

vi.mock('../ink-scroll-renderer.js', () => ({
  setTranscriptScrollHint: setTranscriptScrollHintSpy,
}));

vi.mock('../clipboard.js', () => ({
  writeClipboard: writeClipboardMock,
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
    onToggleTool?: (toolId: string) => void;
    onNotify?: (message: string) => void;
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
        onToggleTool={props.onToggleTool}
        onNotify={props.onNotify}
      >
        <Rows labels={labels} />
      </TranscriptView>
    </ThemeContext.Provider>
  );
}

const frameLines = (frame: string | undefined) => (frame ?? '').split('\n').filter(Boolean);

/** Wait past the multi-click window so a deferred tool toggle can fire. */
async function settleMultiClick(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
  });
}

async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

describe('TranscriptView', () => {
  afterEach(() => {
    setFrameSnapshotForTesting(null);
    writeClipboardMock.mockReset();
  });

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

  it('scrolls three rows per mouse wheel report', async () => {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const app = render(view(labels));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    await flushFrame();
    const older = frameLines(app.lastFrame());
    expect(older).toContain('B');
    expect(older).not.toContain('H');

    act(() => app.stdin.write('\x1b[<65;10;5M'));
    await flushFrame();
    expect(frameLines(app.lastFrame())).toEqual(['E', 'F', 'G', 'H']);
  });

  it('toggles expandable tool summaries on a left click release', async () => {
    const onToggleTool = vi.fn();
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          <ToolCallBlock
            toolId="tool-1"
            name="Bash"
            args={{ command: 'npm test' }}
            result={toolSuccess('long output '.repeat(100), {
              toolCallId: 'tool-1',
            })}
            isExpanded={false}
            terminalWidth={60}
            reducedMotion
          />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    act(() => app.stdin.write('\x1b[<0;4;2M'));
    expect(onToggleTool).not.toHaveBeenCalled();
    act(() => app.stdin.write('\x1b[<0;4;2m'));
    // The toggle waits out the multi-click window: expanding a row on the way
    // to a double-click would reflow the transcript under the cursor.
    expect(onToggleTool).not.toHaveBeenCalled();
    await settleMultiClick();
    expect(onToggleTool).toHaveBeenCalledWith('tool-1');
  });

  it('toggles the row that was clicked, not whatever moved under the cursor', async () => {
    // The toggle is deferred past the multi-click window; a streaming transcript
    // grows inside it, so re-hit-testing the stored coordinates when the timer
    // fires would expand a different row than the one that was clicked.
    const onToggleTool = vi.fn();
    const block = (toolId: string) => (
      <ToolCallBlock
        toolId={toolId}
        name="Bash"
        args={{ command: 'npm test' }}
        result={toolSuccess('long output '.repeat(100), { toolCallId: toolId })}
        isExpanded={false}
        terminalWidth={60}
        reducedMotion
      />
    );
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          {block('tool-1')}
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    act(() => app.stdin.write('[<0;4;2M'));
    act(() => app.stdin.write('[<0;4;2m'));
    // The transcript grows before the deferred toggle fires.
    app.rerender(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          {block('tool-0')}
          {block('tool-1')}
        </TranscriptView>
      </ThemeContext.Provider>,
    );
    await settleMultiClick();

    expect(onToggleTool).toHaveBeenCalledWith('tool-1');
  });

  it('does not toggle a tool row when the click becomes a double-click', async () => {
    const onToggleTool = vi.fn();
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          <ToolCallBlock
            toolId="tool-1"
            name="Bash"
            args={{ command: 'npm test' }}
            result={toolSuccess('long output '.repeat(100), {
              toolCallId: 'tool-1',
            })}
            isExpanded={false}
            terminalWidth={60}
            reducedMotion
          />
        </TranscriptView>
      </ThemeContext.Provider>,
    );

    act(() => app.stdin.write('\x1b[<0;4;2M'));
    act(() => app.stdin.write('\x1b[<0;4;2m'));
    act(() => app.stdin.write('\x1b[<0;4;2M'));
    act(() => app.stdin.write('\x1b[<0;4;2m'));
    await settleMultiClick();

    expect(onToggleTool).not.toHaveBeenCalled();
  });

  it('copies the selected rows when a drag spans them', async () => {
    const onNotify = vi.fn();
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { onNotify }));
    setFrameSnapshotForTesting('\nC\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    // Press at the first column of "D", drag to the first column of "E".
    act(() => app.stdin.write('\x1b[<0;1;3M'));
    act(() => app.stdin.write('\x1b[<32;1;4M'));
    act(() => app.stdin.write('\x1b[<0;1;4m'));
    await flushFrame();

    expect(writeClipboardMock).toHaveBeenCalledWith('D\nE');
    expect(onNotify).toHaveBeenCalledWith('Copied selection to clipboard.');
  });

  it('copies only the dragged columns, not the whole row', async () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nalpha beta gamma\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    // Columns 7..10 of row 2 — "beta" and nothing around it.
    act(() => app.stdin.write('\x1b[<0;7;2M'));
    act(() => app.stdin.write('\x1b[<32;10;2M'));
    act(() => app.stdin.write('\x1b[<0;10;2m'));
    await flushFrame();

    expect(writeClipboardMock).toHaveBeenCalledWith('beta');
  });

  it('leaves the selection highlighted after the button is released', async () => {
    // Releasing copies; it does not deselect. The highlight has to survive the
    // release the way it does in any other text surface.
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nalpha beta gamma\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    act(() => app.stdin.write('\x1b[<0;7;2M'));
    act(() => app.stdin.write('\x1b[<32;10;2M'));
    const duringDrag = app.stdout.frames.length;
    act(() => app.stdin.write('\x1b[<0;10;2m'));
    await flushFrame();

    // The release repaints the inverse-video span rather than clearing it.
    const afterRelease = app.stdout.frames.slice(duringDrag).join('');
    expect(afterRelease).toContain('\x1b[7mbeta\x1b[27m');
  });

  it('undoes the wider drag paint when the release shrinks the selection', async () => {
    // The release carries its own coordinates, so dragging back toward the
    // anchor resolves to fewer cells than the last move painted. Without
    // restoring first, the extra cells stay inverted until some later frame
    // happens to overwrite those rows.
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nalpha beta gamma\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    act(() => app.stdin.write('\x1b[<0;1;2M'));
    act(() => app.stdin.write('\x1b[<32;16;2M'));
    const duringDrag = app.stdout.frames.length;
    // Release back at column 5 — a narrower selection than was painted.
    act(() => app.stdin.write('\x1b[<0;5;2m'));
    await flushFrame();

    const afterRelease = app.stdout.frames.slice(duringDrag).join('');
    // The row is repainted from the frame before the narrower span goes down.
    expect(afterRelease).toContain('\x1b[2;1Halpha beta gamma\x1b[K');
    expect(writeClipboardMock).toHaveBeenCalledWith('alpha');
  });

  it('drops a persisted selection when the transcript is scrolled', async () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nalpha beta gamma\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    act(() => app.stdin.write('\x1b[<0;7;2M'));
    act(() => app.stdin.write('\x1b[<32;10;2M'));
    act(() => app.stdin.write('\x1b[<0;10;2m'));
    await flushFrame();

    // Scrolling moves the rows out from under the highlight.
    const beforeScroll = app.stdout.frames.length;
    act(() => app.stdin.write('\x15'));
    await flushFrame();

    expect(app.stdout.frames.slice(beforeScroll).join('')).not.toContain('\x1b[7m');
  });

  it('selects the word under a double-click', async () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nedited src/tui/app.tsx now\nD\nE\nF');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    // Two presses on the same cell inside the multi-click window, mid-path.
    act(() => app.stdin.write('\x1b[<0;10;2M'));
    act(() => app.stdin.write('\x1b[<0;10;2m'));
    act(() => app.stdin.write('\x1b[<0;10;2M'));
    act(() => app.stdin.write('\x1b[<0;10;2m'));
    await flushFrame();

    expect(writeClipboardMock).toHaveBeenCalledWith('src/tui/app.tsx');
  });

  it('ignores mouse interaction while inactive', async () => {
    const onToggleTool = vi.fn();
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { isActive: false, onToggleTool }));

    act(() => app.stdin.write('\x1b[<64;10;5M'));
    act(() => app.stdin.write('\x1b[<0;4;2M\x1b[<0;4;2m'));
    await flushFrame();

    expect(frameLines(app.lastFrame())).toEqual(['C', 'D', 'E', 'F']);
    expect(onToggleTool).not.toHaveBeenCalled();
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
