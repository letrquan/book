import { Box, measureElement, type DOMElement } from 'ink';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranscriptLayoutChange, useTranscriptViewport } from '../transcript-layout.js';

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
  entries: Array<{ item: T; index: number; key: string; measurementKey: string }>;
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

  const measure = useCallback((measurementKey: string, rows: number) => {
    const height = Math.max(1, Math.floor(rows));
    if (heightCacheRef.current.get(measurementKey) === height) return;
    heightCacheRef.current.set(measurementKey, height);
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

  return {
    ...range,
    entries: items.slice(range.startIndex, range.endIndex).map((item, offset) => {
      const index = range.startIndex + offset;
      return { item, index, key: itemKeys[index]!, measurementKey: measurementKeys[index]! };
    }),
    measure,
    virtualized: shouldVirtualize,
    estimatedTotalRows,
  };
}

export const VirtualTranscriptRow = React.memo(function VirtualTranscriptRow({
  measurementKey,
  onMeasure,
  children,
}: {
  measurementKey: string;
  onMeasure: (measurementKey: string, rows: number) => void;
  children: React.ReactNode;
}) {
  const rowRef = useRef<DOMElement>(null);

  useLayoutEffect(() => {
    if (!rowRef.current) return;
    onMeasure(measurementKey, measureElement(rowRef.current).height);
  }, [children, measurementKey, onMeasure]);

  return (
    <Box ref={rowRef} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  );
});
