import { Box, Text } from 'ink';
import { act, Profiler } from 'react';
import { useState } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { TranscriptView, type TranscriptScrollRequest } from './TranscriptView.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ChatPanel } from './ChatPanel.js';
import { InputBar } from './InputBar.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { toolSuccess } from '../../tools/result.js';
import type { Message } from '../../types/messages.js';
import { useTranscriptHistoryLoader, type TranscriptHistoryLoader } from '../transcript-layout.js';
import { setFrameSnapshotForTesting } from '../frame-buffer.js';
import { halfPageScrollDirection, pagerChordsAvailable } from '../transcript-scroll.js';

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

  it('toggles expandable tool summaries on a left click release', () => {
    const onToggleTool = vi.fn();
    const toolView = (isExpanded: boolean) => (
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={6} width={60} onToggleTool={onToggleTool}>
          <ToolCallBlock
            toolId="tool-1"
            name="Bash"
            args={{ command: 'npm test' }}
            result={toolSuccess('long output '.repeat(100), {
              toolCallId: 'tool-1',
            })}
            isExpanded={isExpanded}
            terminalWidth={60}
            reducedMotion
          />
        </TranscriptView>
      </ThemeContext.Provider>
    );
    const app = render(toolView(false));

    act(() => app.stdin.write('\x1b[<0;4;2M'));
    expect(onToggleTool).not.toHaveBeenCalled();
    act(() => app.stdin.write('\x1b[<0;4;2m'));
    expect(onToggleTool).toHaveBeenCalledWith('tool-1', false);

    onToggleTool.mockClear();
    app.rerender(toolView(true));
    act(() => app.stdin.write('\x1b[<0;4;2M\x1b[<0;4;2m'));
    expect(onToggleTool).toHaveBeenCalledWith('tool-1', true);
  });

  it('copies exact character ranges and keeps the released selection highlighted', async () => {
    const onNotify = vi.fn();
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { onNotify }));
    setFrameSnapshotForTesting('\nalpha\nbravo\ncharlie\ndelta');
    writeClipboardMock.mockResolvedValueOnce('clipboard');

    act(() => app.stdin.write('\x1b[<0;2;3M'));
    act(() => app.stdin.write('\x1b[<32;4;4M'));
    act(() => app.stdin.write('\x1b[<0;4;4m'));
    await flushFrame();

    expect(writeClipboardMock).toHaveBeenCalledWith('ravo\nchar');
    expect(onNotify).toHaveBeenCalledWith('Copied selection to clipboard.');
    expect(app.stdout.lastFrame()).toContain('\x1b[7m');

    act(() => app.stdin.write('x'));
    expect(app.stdout.lastFrame()).not.toContain('\x1b[7m');
  });

  it('does not claim an unconfirmed terminal clipboard request succeeded', async () => {
    const onNotify = vi.fn();
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F'], { onNotify }));
    setFrameSnapshotForTesting('\nalpha\nbravo\ncharlie\ndelta');
    writeClipboardMock.mockResolvedValueOnce('terminal');

    act(() => app.stdin.write('\x1b[<0;2;3M'));
    act(() => app.stdin.write('\x1b[<32;4;4M'));
    act(() => app.stdin.write('\x1b[<0;4;4m'));
    await flushFrame();

    expect(onNotify).toHaveBeenCalledWith('Sent selection to the terminal clipboard.');
  });

  it('leaves Shift+drag available for terminal-native selection', async () => {
    const app = render(view(['A', 'B', 'C', 'D', 'E', 'F']));
    setFrameSnapshotForTesting('\nalpha\nbravo\ncharlie\ndelta');

    act(() => app.stdin.write('\x1b[<4;2;3M'));
    act(() => app.stdin.write('\x1b[<36;4;4M'));
    act(() => app.stdin.write('\x1b[<4;4;4m'));
    await flushFrame();

    expect(writeClipboardMock).not.toHaveBeenCalled();
    expect(app.stdout.lastFrame()).not.toContain('\x1b[7m');
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

// Ctrl+U reads as "clear the line" in every shell, and Ctrl+D as half a page
// forward. Ink hands every key to every handler, so the transcript scrolled
// while the composer was editing a draft with the same key: a long reply
// filling the transcript jumped half a page every time the prompt was cleared.
describe('TranscriptView chords with the composer', () => {
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];

  /**
   * The wiring `app.tsx` uses: the composer owns the keys, reports the chords
   * it had nothing to edit through `onGlobalShortcut` (its `forwardEmptyChord`),
   * and the app hands those back to the transcript as a scroll request.
   */
  function Composer({
    composerAcceptsInput = true,
    sheetEditorFocused = false,
  }: {
    composerAcceptsInput?: boolean;
    sheetEditorFocused?: boolean;
  }) {
    const [scroll, setScroll] = useState<TranscriptScrollRequest>({ key: 0, direction: 'up' });
    return (
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <Box flexDirection="column" width={20} height={9}>
          <TranscriptView
            height={5}
            width={20}
            // The derivation `app.tsx` uses, so this harness cannot drift from it
            // the way a hand-written `!composerAcceptsInput` did.
            pagerChordsAvailable={pagerChordsAvailable({
              composerAcceptsInput,
              sheetEditorFocused,
            })}
            scrollRequest={scroll}
          >
            <Rows labels={labels} />
          </TranscriptView>
          <InputBar
            onSubmit={() => {}}
            submissionMode="submit"
            mode="default"
            onCycleMode={() => {}}
            terminalWidth={20}
            inputSuppressed={!composerAcceptsInput}
            onGlobalShortcut={(input, key) => {
              const direction = halfPageScrollDirection(input, key);
              if (!direction) return false;
              setScroll((current) => ({ key: current.key + 1, direction }));
              return true;
            }}
          />
        </Box>
      </ThemeContext.Provider>
    );
  }

  const visible = (app: ReturnType<typeof render>) =>
    labels.filter((label) => frameLines(app.lastFrame()).includes(label));
  const browsing = (app: ReturnType<typeof render>) =>
    frameLines(app.lastFrame()).some((line) => line.includes('browsing history'));

  it('edits the draft instead of scrolling when Ctrl+U clears the whole line', () => {
    const app = render(<Composer />);
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);

    act(() => app.stdin.write('fix the bug'));
    act(() => app.stdin.write('\x15'));

    // The draft is gone — Ctrl+U killed the text before the cursor, which was
    // all of it — and the transcript is exactly where the user left it.
    expect(app.lastFrame()).not.toContain('fix the bug');
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
    expect(browsing(app)).toBe(false);
  });

  it('does not scroll while a draft is in hand, whatever the sheet state', () => {
    // The regression the truth table exists for. The composer is live and holds
    // a draft, and no sheet editor is open — the exact case the inverted
    // derivation read as "page directly", so Ctrl+U cleared the draft and jumped
    // the transcript half a page in the same keystroke. With the composer taking
    // the keys the transcript's own branch stays out of the way, and a sheet
    // editor being open is no reason for it to step in either.
    for (const sheetEditorFocused of [false, true]) {
      const app = render(<Composer sheetEditorFocused={sheetEditorFocused} />);
      expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);

      act(() => app.stdin.write('fix the bug'));
      act(() => app.stdin.write('\x15'));

      expect(app.lastFrame()).not.toContain('fix the bug');
      expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
      expect(browsing(app)).toBe(false);
      cleanup();
    }
  });

  it('scrolls half a page once the composer has nothing left to edit', () => {
    const app = render(<Composer />);

    act(() => app.stdin.write('\x15'));
    expect(visible(app)).toEqual(['A', 'B', 'C', 'D']);
    expect(browsing(app)).toBe(true);

    act(() => app.stdin.write('\x04'));
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
  });

  it('keeps scrolling with the chords while a sheet owns the keys', () => {
    // A permission prompt silences the composer, so no empty chord is ever
    // reported and the transcript's own handler has to keep the key.
    const app = render(<Composer composerAcceptsInput={false} />);

    act(() => app.stdin.write('\x15'));
    expect(visible(app)).toEqual(['A', 'B', 'C', 'D']);

    act(() => app.stdin.write('\x04'));
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
  });

  it('stops paging while a sheet editor has the focus', () => {
    // Plan approval's feedback editor, AskUserQuestion's `Other` field and an
    // MCP text field are composers: Ctrl+U clears them and Ctrl+D deletes under
    // the cursor. The app knows an editor is open and reports it the way it
    // reports a sheet's height, so the transcript does not also read the chord
    // as a half-page scroll — the same defect #296 was, one surface down.
    const app = render(<Composer composerAcceptsInput={false} sheetEditorFocused />);

    act(() => app.stdin.write('\x15'));
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
    expect(browsing(app)).toBe(false);

    act(() => app.stdin.write('\x04'));
    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
  });

  it('does not replay an old scroll request when the session remounts', () => {
    // `app.tsx` keys this component on the session, so /resume and /clear mount
    // a new one while `scrollRequest` still carries the count from the session
    // before. A ref seeded at zero rather than at the request in hand replays
    // that count, and the new session opens scrolled half a page back and no
    // longer following output.
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <Box flexDirection="column" width={20} height={9}>
          <TranscriptView height={5} width={20} scrollRequest={{ key: 7, direction: 'up' }}>
            <Rows labels={labels} />
          </TranscriptView>
        </Box>
      </ThemeContext.Provider>,
    );

    expect(visible(app)).toEqual(['C', 'D', 'E', 'F']);
    expect(browsing(app)).toBe(false);
  });
});
