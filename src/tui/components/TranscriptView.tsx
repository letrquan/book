import { Box, Text, measureElement, useInput, useStdin, type DOMElement } from 'ink';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
import { parseSgrMouseEvent } from '../mouse.js';
import { useTheme } from '../theme.js';
import {
  ToolRowInteractionContext,
  type ToolSummaryRowRegistration,
} from './tool-row-interactions.js';

interface TranscriptViewProps {
  children: ReactNode;
  height?: number;
  width?: number;
  isActive?: boolean;
  followRequestKey?: number;
  onToggleTool?: (toolId: string) => void;
}

const INITIAL_METRICS: TranscriptMetrics = { contentRows: 0, viewportRows: 1 };
const MOUSE_WHEEL_ROWS = 2;
const MOUSE_WHEEL_FRAME_MS = 16;

function getAbsolutePosition(node: DOMElement): { x: number; y: number } | undefined {
  let current: DOMElement | undefined = node;
  let x = 0;
  let y = 0;
  while (current?.parentNode) {
    if (!current.yogaNode) return undefined;
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }
  return { x, y };
}

export function TranscriptView({
  children,
  height,
  width,
  isActive = true,
  followRequestKey = 0,
  onToggleTool,
}: TranscriptViewProps) {
  const theme = useTheme();
  const { internal_eventEmitter } = useStdin();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const metricsRef = useRef(INITIAL_METRICS);
  const stateRef = useRef<TranscriptScrollState>(createTranscriptScrollState());
  const previousContentRowsRef = useRef(0);
  const previousFollowRequestRef = useRef(followRequestKey);
  const pendingWheelRowsRef = useRef(0);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWheelFlushRef = useRef<number | null>(null);
  const onToggleToolRef = useRef(onToggleTool);
  const [scrollState, setScrollState] = useState(createTranscriptScrollState);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const toolRowsRef = useRef(new Map<string, ToolSummaryRowRegistration>());
  const interactionRegistry = useMemo(
    () => ({
      register: (registration: ToolSummaryRowRegistration) => {
        toolRowsRef.current.set(registration.id, registration);
        return () => {
          if (toolRowsRef.current.get(registration.id) === registration) {
            toolRowsRef.current.delete(registration.id);
          }
        };
      },
    }),
    [],
  );

  const applyScrollState = useCallback((next: TranscriptScrollState) => {
    stateRef.current = next;
    setScrollState((current) =>
      current.scrollTop === next.scrollTop && current.followBottom === next.followBottom
        ? current
        : next,
    );
    if (next.followBottom) setHasNewOutput(false);
  }, []);

  onToggleToolRef.current = onToggleTool;

  const cancelWheelScroll = useCallback(() => {
    pendingWheelRowsRef.current = 0;
    lastWheelFlushRef.current = null;
    if (wheelTimerRef.current !== null) {
      clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
    }
  }, []);

  const flushWheelScroll = useCallback(() => {
    const rows = pendingWheelRowsRef.current;
    pendingWheelRowsRef.current = 0;
    if (rows === 0) return;
    lastWheelFlushRef.current = Date.now();
    applyScrollState(scrollTranscriptBy(stateRef.current, metricsRef.current, rows));
  }, [applyScrollState]);

  const scheduleWheelScroll = useCallback(
    (rows: number) => {
      pendingWheelRowsRef.current += rows;
      const now = Date.now();
      const lastFlush = lastWheelFlushRef.current;
      if (lastFlush === null || now - lastFlush >= MOUSE_WHEEL_FRAME_MS) {
        flushWheelScroll();
        return;
      }
      if (wheelTimerRef.current !== null) return;
      wheelTimerRef.current = setTimeout(
        () => {
          wheelTimerRef.current = null;
          flushWheelScroll();
        },
        MOUSE_WHEEL_FRAME_MS - (now - lastFlush),
      );
    },
    [flushWheelScroll],
  );

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
    cancelWheelScroll();
    applyScrollState(scrollTranscriptToEnd(metricsRef.current));
  }, [applyScrollState, cancelWheelScroll, followRequestKey]);

  useEffect(() => {
    if (!isActive) return;

    const handleMouseInput = (input: string) => {
      const event = parseSgrMouseEvent(input);
      if (!event) return;
      if (event.type === 'wheel') {
        const rows = event.button === 'wheel-up' ? -MOUSE_WHEEL_ROWS : MOUSE_WHEEL_ROWS;
        scheduleWheelScroll(rows);
        return;
      }
      const toggleTool = onToggleToolRef.current;
      if (event.type !== 'press' || event.button !== 'left' || !toggleTool) return;

      const x = event.x - 1;
      const y = event.y - 1;
      for (const registration of toolRowsRef.current.values()) {
        if (!registration.expandable || !registration.element.current) continue;
        const rect = measureElement(registration.element.current);
        const position = getAbsolutePosition(registration.element.current);
        if (
          position &&
          x >= position.x &&
          x < position.x + rect.width &&
          y >= position.y &&
          y < position.y + rect.height
        ) {
          toggleTool(registration.id);
          return;
        }
      }
    };

    internal_eventEmitter.on('input', handleMouseInput);
    return () => {
      internal_eventEmitter.removeListener('input', handleMouseInput);
      cancelWheelScroll();
    };
  }, [cancelWheelScroll, internal_eventEmitter, isActive, scheduleWheelScroll]);

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

      if (next) {
        cancelWheelScroll();
        applyScrollState(next);
      }
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
          <ToolRowInteractionContext.Provider value={interactionRegistry}>
            {children}
          </ToolRowInteractionContext.Provider>
        </Box>
      </Box>
    </Box>
  );
}
