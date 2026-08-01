import { Box, Text, measureElement, useInput, useStdin, type DOMElement } from 'ink';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createTranscriptScrollState,
  getTranscriptHalfPageRows,
  getTranscriptPageRows,
  getTranscriptWheelDrainRows,
  reconcileTranscriptScroll,
  scrollTranscriptBy,
  scrollTranscriptToEnd,
  scrollTranscriptToStart,
  type TranscriptMetrics,
  type TranscriptScrollState,
} from '../transcript-scroll.js';
import { parseSgrMouseEvents } from '../mouse.js';
import {
  TranscriptHistoryContext,
  TranscriptLayoutContext,
  TranscriptViewportContext,
  type TranscriptHistoryLoader,
  type TranscriptViewportStore,
} from '../transcript-layout.js';
import { useTheme } from '../theme.js';
import { setTranscriptScrollHint } from '../ink-scroll-renderer.js';
import { markTranscriptScrollActivity } from '../scroll-activity.js';
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
  /** Structural layout changes outside transcript components that self-report height updates. */
  layoutRevision?: unknown;
  onToggleTool?: (toolId: string) => void;
}

const INITIAL_METRICS: TranscriptMetrics = { contentRows: 0, viewportRows: 1 };
const MOUSE_WHEEL_ROWS = 3;

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

interface TranscriptContentProps {
  children: ReactNode;
  interactionRegistry: {
    register: (registration: ToolSummaryRowRegistration) => () => void;
  };
  historyRegistry: {
    register: (loader: TranscriptHistoryLoader) => () => void;
  };
  viewportStore: TranscriptViewportStore;
  onLayoutChange: () => void;
}

const TranscriptContent = memo(function TranscriptContent({
  children,
  interactionRegistry,
  historyRegistry,
  viewportStore,
  onLayoutChange,
}: TranscriptContentProps) {
  return (
    <TranscriptLayoutContext.Provider value={onLayoutChange}>
      <TranscriptHistoryContext.Provider value={historyRegistry}>
        <TranscriptViewportContext.Provider value={viewportStore}>
          <ToolRowInteractionContext.Provider value={interactionRegistry}>
            {children}
          </ToolRowInteractionContext.Provider>
        </TranscriptViewportContext.Provider>
      </TranscriptHistoryContext.Provider>
    </TranscriptLayoutContext.Provider>
  );
});

export function TranscriptView({
  children,
  height,
  width,
  isActive = true,
  followRequestKey = 0,
  layoutRevision,
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
  const wheelImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null);
  const layoutMeasureImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null);
  const onToggleToolRef = useRef(onToggleTool);
  const [renderedScrollTop, setRenderedScrollTop] = useState(0);
  const [followBottom, setFollowBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const toolRowsRef = useRef(new Map<string, ToolSummaryRowRegistration>());
  const historyLoaderRef = useRef<TranscriptHistoryLoader | null>(null);
  const viewportListenersRef = useRef(new Set<() => void>());
  const viewportRevisionRef = useRef(0);
  const viewportBucketRef = useRef('');
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
  const historyRegistry = useMemo(
    () => ({
      register: (loader: TranscriptHistoryLoader) => {
        historyLoaderRef.current = loader;
        return () => {
          if (historyLoaderRef.current === loader) historyLoaderRef.current = null;
        };
      },
    }),
    [],
  );
  const viewportStore = useMemo<TranscriptViewportStore>(
    () => ({
      subscribe: (listener) => {
        viewportListenersRef.current.add(listener);
        return () => viewportListenersRef.current.delete(listener);
      },
      getRevision: () => viewportRevisionRef.current,
      getSnapshot: () => ({
        scrollTop: stateRef.current.scrollTop,
        viewportRows: metricsRef.current.viewportRows,
        followBottom: stateRef.current.followBottom,
      }),
    }),
    [],
  );

  const publishViewport = useCallback((state: TranscriptScrollState) => {
    const viewportRows = metricsRef.current.viewportRows;
    const bucketRows = Math.max(1, getTranscriptHalfPageRows(viewportRows));
    const bucket = `${Math.floor(state.scrollTop / bucketRows)}:${viewportRows}:${state.followBottom}`;
    if (viewportBucketRef.current === bucket) return;

    viewportBucketRef.current = bucket;
    viewportRevisionRef.current++;
    for (const listener of viewportListenersRef.current) listener();
  }, []);

  const applyScrollState = useCallback(
    (next: TranscriptScrollState) => {
      const previous = stateRef.current;
      stateRef.current = next;
      if (previous.scrollTop !== next.scrollTop) markTranscriptScrollActivity();

      if (
        previous.scrollTop !== next.scrollTop &&
        previous.followBottom === next.followBottom &&
        viewportRef.current
      ) {
        const position = getAbsolutePosition(viewportRef.current);
        const viewportHeight = Math.max(1, Math.floor(measureElement(viewportRef.current).height));
        if (position) {
          setTranscriptScrollHint({
            top: position.y + 1,
            bottom: position.y + viewportHeight,
            delta: next.scrollTop - previous.scrollTop,
          });
        }
      }

      setRenderedScrollTop((current) => (current === next.scrollTop ? current : next.scrollTop));
      setFollowBottom((current) => (current === next.followBottom ? current : next.followBottom));
      if (next.followBottom) setHasNewOutput(false);
      publishViewport(next);
    },
    [publishViewport],
  );

  onToggleToolRef.current = onToggleTool;

  const cancelWheelScroll = useCallback(() => {
    pendingWheelRowsRef.current = 0;
    if (wheelImmediateRef.current !== null) {
      clearImmediate(wheelImmediateRef.current);
      wheelImmediateRef.current = null;
    }
  }, []);

  const flushWheelScroll = useCallback(() => {
    wheelImmediateRef.current = null;
    const rows = getTranscriptWheelDrainRows(
      pendingWheelRowsRef.current,
      metricsRef.current.viewportRows,
    );
    if (rows === 0) return;

    pendingWheelRowsRef.current -= rows;
    const previous = stateRef.current;
    const next = scrollTranscriptBy(previous, metricsRef.current, rows);
    applyScrollState(next);

    if (next.scrollTop === previous.scrollTop) {
      pendingWheelRowsRef.current = 0;
      return;
    }
    if (
      rows < 0 &&
      next.scrollTop === 0 &&
      pendingWheelRowsRef.current < 0 &&
      historyLoaderRef.current?.('page')
    ) {
      pendingWheelRowsRef.current = 0;
      return;
    }
    if (pendingWheelRowsRef.current !== 0) {
      wheelImmediateRef.current = setImmediate(flushWheelScroll);
    }
  }, [applyScrollState]);

  const scheduleWheelScroll = useCallback(
    (rows: number) => {
      pendingWheelRowsRef.current += rows;
      if (wheelImmediateRef.current !== null) return;
      // Coalesce terminal data bursts without adding a fixed frame delay.
      wheelImmediateRef.current = setImmediate(flushWheelScroll);
    },
    [flushWheelScroll],
  );

  const measureTranscript = useCallback(() => {
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
  }, [applyScrollState, height]);

  const cancelScheduledLayoutMeasure = useCallback(() => {
    if (layoutMeasureImmediateRef.current !== null) {
      clearImmediate(layoutMeasureImmediateRef.current);
      layoutMeasureImmediateRef.current = null;
    }
  }, []);

  const scheduleLayoutMeasure = useCallback(() => {
    if (layoutMeasureImmediateRef.current !== null) return;
    layoutMeasureImmediateRef.current = setImmediate(() => {
      layoutMeasureImmediateRef.current = null;
      measureTranscript();
    });
  }, [measureTranscript]);

  const layoutDependency = layoutRevision === undefined ? children : layoutRevision;
  useLayoutEffect(() => {
    cancelScheduledLayoutMeasure();
    measureTranscript();
  }, [cancelScheduledLayoutMeasure, height, layoutDependency, measureTranscript, width]);

  useEffect(
    () => () => {
      cancelScheduledLayoutMeasure();
    },
    [cancelScheduledLayoutMeasure],
  );

  useLayoutEffect(() => {
    if (previousFollowRequestRef.current === followRequestKey) return;
    previousFollowRequestRef.current = followRequestKey;
    cancelWheelScroll();
    applyScrollState(scrollTranscriptToEnd(metricsRef.current));
  }, [applyScrollState, cancelWheelScroll, followRequestKey]);

  useEffect(() => {
    if (!isActive) return;

    const handleMouseInput = (input: string) => {
      const events = parseSgrMouseEvents(input);
      if (events.length === 0) return;

      for (const event of events) {
        if (event.type === 'wheel') {
          const rows = event.button === 'wheel-up' ? -MOUSE_WHEEL_ROWS : MOUSE_WHEEL_ROWS;
          if (rows < 0 && stateRef.current.scrollTop === 0 && historyLoaderRef.current?.('page')) {
            continue;
          }
          scheduleWheelScroll(rows);
          continue;
        }

        const toggleTool = onToggleToolRef.current;
        if (event.type !== 'press' || event.button !== 'left' || !toggleTool) continue;

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
            break;
          }
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
        if (stateRef.current.scrollTop === 0 && historyLoaderRef.current?.('page')) return;
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
        historyLoaderRef.current?.('all');
        next = scrollTranscriptToStart();
      } else if (key.ctrl && key.end) {
        next = scrollTranscriptToEnd(metrics);
      } else if (key.ctrl && input.toLowerCase() === 'u') {
        if (stateRef.current.scrollTop === 0 && historyLoaderRef.current?.('page')) return;
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
        {!followBottom ? (
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
          marginTop={-renderedScrollTop}
        >
          <TranscriptContent
            interactionRegistry={interactionRegistry}
            historyRegistry={historyRegistry}
            viewportStore={viewportStore}
            onLayoutChange={scheduleLayoutMeasure}
          >
            {children}
          </TranscriptContent>
        </Box>
      </Box>
    </Box>
  );
}
