import { Box, Text } from 'ink';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  TranscriptViewportContext,
  type TranscriptViewportSnapshot,
  type TranscriptViewportStore,
} from '../transcript-layout.js';
import {
  getVirtualTranscriptRange,
  useVirtualTranscript,
  VirtualTranscriptRow,
} from './virtual-transcript.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { TranscriptView } from './TranscriptView.js';

describe('virtual transcript range', () => {
  it('keeps the viewport covered with overscan while preserving spacer rows', () => {
    const range = getVirtualTranscriptRange(
      Array.from({ length: 100 }, () => 1),
      50,
      10,
      10,
      false,
    );

    expect(range.startIndex).toBe(39);
    expect(range.endIndex).toBe(70);
    expect(range.topSpacerRows).toBe(39);
    expect(range.bottomSpacerRows).toBe(30);
    expect(range.totalRows).toBe(100);
  });

  it('anchors the initial follow-bottom range at the tail', () => {
    const range = getVirtualTranscriptRange(
      Array.from({ length: 100 }, () => 1),
      0,
      10,
      10,
      true,
    );

    expect(range.endIndex).toBe(100);
    expect(range.startIndex).toBe(79);
    expect(range.topSpacerRows).toBe(79);
    expect(range.bottomSpacerRows).toBe(0);
  });
});

interface StoreHarnessProps {
  items: string[];
}

function StoreHarness({ items }: StoreHarnessProps) {
  const window = useVirtualTranscript({
    items,
    enabled: true,
    terminalWidth: 80,
    getKey: (item) => item,
    estimateRows: () => 1,
  });
  return <Text>{window.entries.map(({ item }) => item).join(',')}</Text>;
}

interface StreamingItem {
  id: string;
  text: string;
}

function StreamingHarness({ items }: { items: StreamingItem[] }) {
  const window = useVirtualTranscript({
    items,
    enabled: true,
    terminalWidth: 80,
    getKey: (item) => item.id,
    estimateRows: (item) => Math.max(1, Math.ceil(item.text.length / 10)),
  });
  return (
    <>
      <Text>{`total:${window.totalRows}`}</Text>
      {window.entries.map(({ item, key, measurementKey }) => (
        <VirtualTranscriptRow key={key} measurementKey={measurementKey} onMeasure={window.measure}>
          <Box height={item.id === 'item-99' ? (item.text.length > 10 ? 4 : 2) : 1}>
            <Text>{item.id}</Text>
          </Box>
        </VirtualTranscriptRow>
      ))}
    </>
  );
}

function createStore(snapshot: TranscriptViewportSnapshot) {
  let revision = 0;
  let current = snapshot;
  const listeners = new Set<() => void>();
  const store: TranscriptViewportStore = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRevision: () => revision,
    getSnapshot: () => current,
  };
  return {
    store,
    setSnapshot(next: TranscriptViewportSnapshot) {
      current = next;
      revision++;
      for (const listener of listeners) listener();
    },
  };
}

describe('useVirtualTranscript', () => {
  it('changes mounted ranges only when the coarse viewport snapshot changes', () => {
    const viewport = createStore({ scrollTop: 0, viewportRows: 5, followBottom: true });
    const items = Array.from({ length: 100 }, (_, index) => `item-${index}`);
    const app = render(
      <TranscriptViewportContext.Provider value={viewport.store}>
        <StoreHarness items={items} />
      </TranscriptViewportContext.Provider>,
    );

    expect(app.lastFrame()).toContain('item-99');
    expect(app.lastFrame()).not.toContain('item-0');

    act(() => {
      viewport.setSnapshot({ scrollTop: 40, viewportRows: 5, followBottom: false });
    });
    expect(app.lastFrame()).toContain('item-40');
    expect(app.lastFrame()).not.toContain('item-99');
  });

  it('replaces an off-screen stream height when its estimate grows', async () => {
    const viewport = createStore({ scrollTop: 0, viewportRows: 5, followBottom: true });
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `item-${index}`,
      text: 'x',
    }));
    const app = render(
      <TranscriptViewportContext.Provider value={viewport.store}>
        <StreamingHarness items={items} />
      </TranscriptViewportContext.Provider>,
    );

    await act(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(app.lastFrame()).toContain('total:101');

    act(() => {
      viewport.setSnapshot({ scrollTop: 0, viewportRows: 5, followBottom: false });
    });
    const updatedItems = items.map((item, index) =>
      index === 99 ? { ...item, text: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } : item,
    );
    app.rerender(
      <TranscriptViewportContext.Provider value={viewport.store}>
        <StreamingHarness items={updatedItems} />
      </TranscriptViewportContext.Provider>,
    );

    expect(app.lastFrame()).toContain('total:103');
  });
});

/** Every item is three rows tall but estimated at one, so each mount corrects its estimate. */
function UnderEstimated({ count }: { count: number }) {
  const items = Array.from({ length: count }, (_, index) => `item-${index}`);
  const window = useVirtualTranscript({
    items,
    enabled: true,
    terminalWidth: 20,
    getKey: (item) => item,
    estimateRows: () => 1,
  });
  return (
    <Box flexDirection="column">
      {window.topSpacerRows > 0 ? <Box height={window.topSpacerRows} flexShrink={0} /> : null}
      {window.entries.map(({ item, key, measurementKey, reserveRows }) => (
        <VirtualTranscriptRow
          key={key}
          measurementKey={measurementKey}
          onMeasure={window.measure}
          reserveRows={reserveRows}
        >
          <Text>{`${item}.a`}</Text>
          <Text>{`${item}.b`}</Text>
          <Text>{`${item}.c`}</Text>
        </VirtualTranscriptRow>
      ))}
      {window.bottomSpacerRows > 0 ? <Box height={window.bottomSpacerRows} flexShrink={0} /> : null}
    </Box>
  );
}

describe('virtual transcript scroll anchoring', () => {
  const transcriptLines = (frame: string | undefined) =>
    (frame ?? '').split('\n').filter((line) => line.trim() && !line.includes('browsing history'));

  async function settle(): Promise<void> {
    for (let index = 0; index < 4; index++) {
      await act(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    }
  }

  // Scrolling up through history that was never measured mounts rows above the view whose
  // estimates are wrong. Each notch must still move the text exactly three rows, in every frame
  // drawn on the way, and measuring history is not new output below (#347).
  it('keeps the text in view still while rows above it are measured', async () => {
    const app = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <TranscriptView height={9} width={20}>
          <UnderEstimated count={60} />
        </TranscriptView>
      </ThemeContext.Provider>,
    );
    await settle();

    for (let step = 0; step < 10; step++) {
      const before = transcriptLines(app.lastFrame());
      const drawn = app.frames.length;
      act(() => app.stdin.write('\x1b[<64;10;5M'));
      await settle();
      const after = transcriptLines(app.lastFrame());
      expect(after.slice(3), `step ${step}`).toEqual(before.slice(0, before.length - 3));
      for (const frame of app.frames.slice(drawn)) {
        expect([before, after], `step ${step}`).toContainEqual(transcriptLines(frame));
      }
      expect(app.lastFrame(), `step ${step}`).not.toContain('new output');
      // Past the wheel's run gap, so each notch is a lone notch of three rows.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    }
    app.unmount();
  });
});
