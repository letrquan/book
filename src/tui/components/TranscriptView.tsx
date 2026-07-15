import { Box, Text, measureElement, useInput, useStdin, type DOMElement } from 'ink';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  createTranscriptScrollState,
  getTranscriptHalfPageRows,
  getTranscriptPageRows,
  reconcileTranscriptScroll,
  scrollTranscriptBy,
  scrollTranscriptToEnd,
  scrollTranscriptToStart,
  type TranscriptMetrics,
  type TranscriptScrollState,
} from '../transcript-scroll.js';
import { parseMouseWheelDirection } from '../mouse.js';
import { useTheme } from '../theme.js';

interface TranscriptViewProps {
  children: ReactNode;
  height?: number;
  width?: number;
  isActive?: boolean;
  followRequestKey?: number;
}

const INITIAL_METRICS: TranscriptMetrics = { contentRows: 0, viewportRows: 1 };
const MOUSE_WHEEL_ROWS = 3;

export function TranscriptView({
  children,
  height,
  width,
  isActive = true,
  followRequestKey = 0,
}: TranscriptViewProps) {
  const theme = useTheme();
  const { internal_eventEmitter } = useStdin();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const metricsRef = useRef(INITIAL_METRICS);
  const stateRef = useRef<TranscriptScrollState>(createTranscriptScrollState());
  const previousContentRowsRef = useRef(0);
  const previousFollowRequestRef = useRef(followRequestKey);
  const [scrollState, setScrollState] = useState(createTranscriptScrollState);
  const [hasNewOutput, setHasNewOutput] = useState(false);

  const applyScrollState = useCallback((next: TranscriptScrollState) => {
    stateRef.current = next;
    setScrollState((current) =>
      current.scrollTop === next.scrollTop && current.followBottom === next.followBottom
        ? current
        : next,
    );
    if (next.followBottom) setHasNewOutput(false);
  }, []);

  useLayoutEffect(() => {
    const viewportRows = viewportRef.current
      ? Math.max(1, Math.floor(measureElement(viewportRef.current).height))
      : Math.max(1, Math.floor(height ?? 1));
    const contentRows = contentRef.current
      ? Math.max(0, Math.floor(measureElement(contentRef.current).height))
      : 0;
    const previousMetrics = metricsRef.current;
    const nextMetrics = { contentRows, viewportRows };

    if (
      contentRows > previousContentRowsRef.current &&
      !stateRef.current.followBottom &&
      previousContentRowsRef.current > 0
    ) {
      setHasNewOutput(true);
    }
    previousContentRowsRef.current = contentRows;

    if (
      previousMetrics.contentRows !== contentRows ||
      previousMetrics.viewportRows !== viewportRows
    ) {
      metricsRef.current = nextMetrics;
      applyScrollState(reconcileTranscriptScroll(stateRef.current, nextMetrics));
    }
  });

  useLayoutEffect(() => {
    if (previousFollowRequestRef.current === followRequestKey) return;
    previousFollowRequestRef.current = followRequestKey;
    applyScrollState(scrollTranscriptToEnd(metricsRef.current));
  }, [applyScrollState, followRequestKey]);

  useEffect(() => {
    if (!isActive) return;

    const handleMouseInput = (input: string) => {
      const direction = parseMouseWheelDirection(input);
      if (!direction) return;

      const rows = direction === 'up' ? -MOUSE_WHEEL_ROWS : MOUSE_WHEEL_ROWS;
      applyScrollState(scrollTranscriptBy(stateRef.current, metricsRef.current, rows));
    };

    internal_eventEmitter.on('input', handleMouseInput);
    return () => {
      internal_eventEmitter.removeListener('input', handleMouseInput);
    };
  }, [applyScrollState, internal_eventEmitter, isActive]);

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;
      const metrics = metricsRef.current;
      let next: TranscriptScrollState | undefined;

      if (key.pageUp) {
        next = scrollTranscriptBy(
          stateRef.current,
          metrics,
          -getTranscriptPageRows(metrics.viewportRows),
        );
      } else if (key.pageDown) {
        next = scrollTranscriptBy(
          stateRef.current,
          metrics,
          getTranscriptPageRows(metrics.viewportRows),
        );
      } else if (key.ctrl && key.home) {
        next = scrollTranscriptToStart();
      } else if (key.ctrl && key.end) {
        next = scrollTranscriptToEnd(metrics);
      } else if (key.ctrl && input.toLowerCase() === 'u') {
        next = scrollTranscriptBy(
          stateRef.current,
          metrics,
          -getTranscriptHalfPageRows(metrics.viewportRows),
        );
      } else if (key.ctrl && input.toLowerCase() === 'd') {
        next = scrollTranscriptBy(
          stateRef.current,
          metrics,
          getTranscriptHalfPageRows(metrics.viewportRows),
        );
      }

      if (next) applyScrollState(next);
    },
    { isActive },
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={height === undefined ? 1 : 0}
      flexShrink={1}
      minHeight={1}
      height={height}
      width={width}
    >
      <Box flexShrink={0} height={1} justifyContent="flex-end">
        {!scrollState.followBottom ? (
          <Text color={theme.subtle} dimColor>
            ↑ browsing history{hasNewOutput ? ' · new output below' : ''}
          </Text>
        ) : null}
      </Box>
      <Box ref={viewportRef} flexGrow={1} flexShrink={1} minHeight={1} overflowY="hidden">
        <Box
          ref={contentRef}
          flexDirection="column"
          flexShrink={0}
          position="absolute"
          width={width}
          marginTop={-scrollState.scrollTop}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
