import { Box, measureElement, type DOMElement } from 'ink';
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cullWhenOffscreen } from '../../cli/ink-render-cull.js';
import {
  TranscriptViewportContext,
  useTranscriptLayoutChange,
  useTranscriptViewport,
} from '../transcript-layout.js';

const DEFAULT_MAX_MOUNTED_ITEMS = 512;

export interface VirtualTranscriptRange {
  startIndex: number;
  endIndex: number;
  topSpacerRows: number;
  bottomSpacerRows: number;
  totalRows: number;
}

interface UseVirtualTranscriptOptions<T> {
  items: readonly T[];
  enabled: boolean;
  terminalWidth: number;
  leadingRows?: number;
  getKey: (item: T) => string;
  estimateRows: (item: T) => number;
}

export interface VirtualTranscriptWindow<T> extends VirtualTranscriptRange {
  entries: Array<{
    item: T;
    index: number;
    key: string;
    measurementKey: string;
    /** Pass to `VirtualTranscriptRow`'s `reserveRows`. */
    reserveRows: number | undefined;
  }>;
  measure: (measurementKey: string, rows: number) => void;
  virtualized: boolean;
  /** Sum of the pre-measurement row estimates for all items. */
  estimatedTotalRows: number;
}

interface DerivedItemEntry {
  width: number;
  key: string;
  estimate: number;
  measurementKey: string;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function getVirtualTranscriptRange(
  heights: readonly number[],
  scrollTop: number,
  viewportRows: number,
  overscanRows: number,
  followBottom: boolean,
  maxMountedItems = DEFAULT_MAX_MOUNTED_ITEMS,
): VirtualTranscriptRange {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index++) {
    offsets[index + 1] = offsets[index]! + Math.max(1, Math.floor(heights[index] ?? 1));
  }

  const totalRows = offsets[heights.length] ?? 0;
  if (heights.length === 0) {
    return { startIndex: 0, endIndex: 0, topSpacerRows: 0, bottomSpacerRows: 0, totalRows };
  }

  const viewport = Math.max(1, Math.floor(viewportRows));
  const overscan = Math.max(0, Math.floor(overscanRows));
  const maxScrollTop = Math.max(0, totalRows - viewport);
  const effectiveScrollTop = followBottom
    ? maxScrollTop
    : Math.max(0, Math.min(Math.floor(scrollTop), maxScrollTop));
  const firstRow = Math.max(0, effectiveScrollTop - overscan);
  const lastRow = Math.min(totalRows, effectiveScrollTop + viewport + overscan);

  let startIndex = Math.max(0, lowerBound(offsets, firstRow) - 1);
  let endIndex = Math.min(heights.length, Math.max(startIndex + 1, lowerBound(offsets, lastRow)));
  const mountedLimit = Math.max(1, Math.floor(maxMountedItems));
  if (endIndex - startIndex > mountedLimit) {
    if (followBottom) startIndex = endIndex - mountedLimit;
    else endIndex = startIndex + mountedLimit;
  }

  return {
    startIndex,
    endIndex,
    topSpacerRows: offsets[startIndex] ?? 0,
    bottomSpacerRows: totalRows - (offsets[endIndex] ?? totalRows),
    totalRows,
  };
}

export function useVirtualTranscript<T>({
  items,
  enabled,
  terminalWidth,
  leadingRows = 0,
  getKey,
  estimateRows,
}: UseVirtualTranscriptOptions<T>): VirtualTranscriptWindow<T> {
  const viewport = useTranscriptViewport();
  const notifyLayoutChange = useTranscriptLayoutChange();
  const heightCacheRef = useRef(new Map<string, number>());
  const [heightVersion, setHeightVersion] = useState(0);
  const width = Math.max(1, Math.floor(terminalWidth));

  // Cache per-item derived values by item identity so a streaming update only
  // recomputes the one message whose object changed, not the whole window.
  const derivedCacheRef = useRef(new WeakMap<object, DerivedItemEntry>());
  const derivedFnsRef = useRef({ getKey, estimateRows });
  if (
    derivedFnsRef.current.getKey !== getKey ||
    derivedFnsRef.current.estimateRows !== estimateRows
  ) {
    derivedCacheRef.current = new WeakMap();
    derivedFnsRef.current = { getKey, estimateRows };
  }
  const derived = useMemo(() => {
    const cache = derivedCacheRef.current;
    const itemKeys = new Array<string>(items.length);
    const estimatedRows = new Array<number>(items.length);
    const measurementKeys = new Array<string>(items.length);
    let estimatedTotalRows = 0;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const cacheable = typeof item === 'object' && item !== null;
      let entry = cacheable ? cache.get(item as object) : undefined;
      if (!entry || entry.width !== width) {
        const key = getKey(item);
        const estimate = Math.max(1, Math.ceil(estimateRows(item)));
        entry = { width, key, estimate, measurementKey: `${width}:${key}:${estimate}` };
        if (cacheable) cache.set(item as object, entry);
      }
      itemKeys[index] = entry.key;
      estimatedRows[index] = entry.estimate;
      measurementKeys[index] = entry.measurementKey;
      estimatedTotalRows += entry.estimate;
    }
    return { itemKeys, estimatedRows, measurementKeys, estimatedTotalRows };
  }, [estimateRows, getKey, items, width]);
  const { itemKeys, estimatedRows, measurementKeys, estimatedTotalRows } = derived;
  const heights = useMemo(
    () =>
      items.map((item, index) =>
        Math.max(1, heightCacheRef.current.get(measurementKeys[index]!) ?? estimatedRows[index]!),
      ),
    [estimatedRows, heightVersion, items, measurementKeys],
  );

  useEffect(() => {
    const activeKeys = new Set(measurementKeys);
    for (const key of heightCacheRef.current.keys()) {
      if (!activeKeys.has(key)) heightCacheRef.current.delete(key);
    }
  }, [measurementKeys]);

  useLayoutEffect(() => {
    if (heightVersion > 0) notifyLayoutChange?.();
  }, [heightVersion, notifyLayoutChange]);

  // What the last render laid out, for `measure` to find where a reporting row starts.
  const laidOutRef = useRef({ measurementKeys, heights, leadingRows });
  laidOutRef.current = { measurementKeys, heights, leadingRows };
  const viewportStore = useContext(TranscriptViewportContext);
  const viewportStoreRef = useRef(viewportStore);
  viewportStoreRef.current = viewportStore;

  const measure = useCallback((measurementKey: string, rows: number) => {
    const height = Math.max(1, Math.floor(rows));
    if (heightCacheRef.current.get(measurementKey) === height) return;
    heightCacheRef.current.set(measurementKey, height);
    // A row that mounted with an estimated height pushes everything under it by the difference.
    // When the whole row is above the view, the view has to move with it or the text being read
    // jumps. A row the view cuts through is left alone: it changed where the reader is looking.
    const laidOut = laidOutRef.current;
    const index = laidOut.measurementKeys.indexOf(measurementKey);
    const laidOutHeight = index >= 0 ? laidOut.heights[index] : undefined;
    if (laidOutHeight !== undefined && laidOutHeight !== height) {
      let endRow = Math.max(0, laidOut.leadingRows) + laidOutHeight;
      for (let item = 0; item < index; item++) endRow += laidOut.heights[item] ?? 1;
      viewportStoreRef.current?.anchorRowsAbove?.(endRow, height - laidOutHeight);
    }
    setHeightVersion((version) => version + 1);
  }, []);

  const shouldVirtualize = enabled && viewport !== null;
  const range = useMemo(() => {
    if (!shouldVirtualize) {
      const totalRows = heights.reduce((sum, rows) => sum + rows, 0);
      return {
        startIndex: 0,
        endIndex: items.length,
        topSpacerRows: 0,
        bottomSpacerRows: 0,
        totalRows,
      };
    }

    return getVirtualTranscriptRange(
      heights,
      Math.max(0, viewport.scrollTop - Math.max(0, leadingRows)),
      viewport.viewportRows,
      Math.max(12, viewport.viewportRows),
      viewport.followBottom,
    );
  }, [heights, items.length, leadingRows, shouldVirtualize, viewport]);

  // A row that has never been measured and mounts wholly above the view is held at the height it
  // was laid out with until it is measured (`VirtualTranscriptRow`'s `reserveRows`). Ink draws a
  // commit before its layout effects run, so without the hold the frame that mounts it would show
  // the text in view pushed by the row's estimate error, and only the next frame would anchor it back.
  const viewportTop = shouldVirtualize && !viewport.followBottom ? viewport.scrollTop : null;
  let rowTop = Math.max(0, leadingRows) + range.topSpacerRows;
  const entries = items.slice(range.startIndex, range.endIndex).map((item, offset) => {
    const index = range.startIndex + offset;
    const measurementKey = measurementKeys[index]!;
    const laidOutRows = heights[index]!;
    const reserveRows =
      viewportTop !== null &&
      rowTop + laidOutRows <= viewportTop &&
      !heightCacheRef.current.has(measurementKey)
        ? laidOutRows
        : undefined;
    rowTop += laidOutRows;
    return { item, index, key: itemKeys[index]!, measurementKey, reserveRows };
  });

  return {
    ...range,
    entries,
    measure,
    virtualized: shouldVirtualize,
    estimatedTotalRows,
  };
}

export const VirtualTranscriptRow = React.memo(function VirtualTranscriptRow({
  measurementKey,
  onMeasure,
  reserveRows,
  children,
}: {
  measurementKey: string;
  onMeasure: (measurementKey: string, rows: number) => void;
  /**
   * Hold the row at this many rows, clipped, until it is measured: set for a row that mounts
   * above the view, so its estimate error lands in the same commit that anchors the view.
   * Read on mount only.
   */
  reserveRows?: number;
  children: React.ReactNode;
}) {
  const contentRef = useRef<DOMElement>(null);
  const outerRef = useRef<DOMElement>(null);
  const [reserved, setReserved] = useState(reserveRows);

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    onMeasure(measurementKey, measureElement(contentRef.current).height);
    // Released in the same commit as the measurement it reported, so the anchored scroll and the
    // row's real height are drawn together.
    if (reserved !== undefined) setReserved(undefined);
  }, [children, measurementKey, onMeasure, reserved]);

  // Mount only: the cull reads the live clip and layout at draw time, so it never needs
  // re-registering.
  useLayoutEffect(() => {
    cullWhenOffscreen(outerRef.current);
  }, []);

  // The inner box keeps its natural height inside a held outer one, so it measures the same
  // either way, and the tree keeps one shape so releasing the hold does not remount the row.
  return (
    <Box
      ref={outerRef}
      flexDirection="column"
      flexShrink={0}
      height={reserved}
      overflow={reserved === undefined ? undefined : 'hidden'}
    >
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
});
