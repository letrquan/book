import { Text } from 'ink';
import { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  TranscriptViewportContext,
  type TranscriptViewportSnapshot,
  type TranscriptViewportStore,
} from '../transcript-layout.js';
import { getVirtualTranscriptRange, useVirtualTranscript } from './virtual-transcript.js';

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
});
