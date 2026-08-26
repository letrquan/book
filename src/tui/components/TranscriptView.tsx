import { Box, Text, measureElement, useInput, useStdin, useStdout, type DOMElement } from 'ink';
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
import { parseSgrMouseEvents, stripSgrMouseSequences } from '../mouse.js';
import { writeClipboard } from '../clipboard.js';
import { getFrameLines, getLastCursorPosition, subscribeToFrameUpdates } from '../frame-buffer.js';
import { paintSelection, restoreSelection } from '../selection-highlight.js';
import {
  extractSelectedText,
  normalizeSelectionRange,
  type SelectionCell,
  type SelectionRange,
} from '../text-selection.js';
import {
  TranscriptHistoryContext,
  TranscriptLayoutContext,
  TranscriptViewportContext,
  type TranscriptHistoryLoader,
  type TranscriptViewportSnapshot,
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
  onToggleTool?: (toolId: string, expanded: boolean) => void;
  onNotify?: (message: string) => void;
  onRedrawViewport?: () => void;
}

const INITIAL_METRICS: TranscriptMetrics = { contentRows: 0, viewportRows: 1 };
const MOUSE_WHEEL_ROWS = 3;

interface DragState {
  anchor: SelectionCell;
  focus: SelectionCell;
  dragged: boolean;
}

const selectionRangesEqual = (left: SelectionRange, right: SelectionRange): boolean =>
  left.start.x === right.start.x &&
  left.start.y === right.start.y &&
  left.end.x === right.end.x &&
  left.end.y === right.end.y;

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
  onNotify,
  onRedrawViewport,
}: TranscriptViewProps) {
  const theme = useTheme();
  const { internal_eventEmitter } = useStdin();
  const { stdout } = useStdout();
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
  const onNotifyRef = useRef(onNotify);
  const onRedrawViewportRef = useRef(onRedrawViewport);
  const dragRef = useRef<DragState | null>(null);
  const selectionRef = useRef<SelectionRange | null>(null);
  const repaintImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null);
  const [renderedScrollTop, setRenderedScrollTop] = useState(0);
  const [followBottom, setFollowBottom] = useState(true);
  const [hasNewOutput, setHasNewOutput] = useState(false);
  const historyLoaderRef = useRef<TranscriptHistoryLoader | null>(null);
  const viewportListenersRef = useRef(new Set<() => void>());
  const viewportRevisionRef = useRef(0);
  const viewportBucketRef = useRef('');
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
  const viewportSnapshotRef = useRef<{
    revision: number;
    snapshot: TranscriptViewportSnapshot;
  } | null>(null);
  const viewportStore = useMemo<TranscriptViewportStore>(
    () => ({
      subscribe: (listener) => {
        viewportListenersRef.current.add(listener);
        return () => viewportListenersRef.current.delete(listener);
      },
      getRevision: () => viewportRevisionRef.current,
      getSnapshot: () => {
        // Keep the snapshot referentially stable between revisions so consumers
        // can use it as a memo dependency without recomputing on every render.
        const revision = viewportRevisionRef.current;
        const cached = viewportSnapshotRef.current;
        if (cached?.revision === revision) return cached.snapshot;
        const snapshot = {
          scrollTop: stateRef.current.scrollTop,
          viewportRows: metricsRef.current.viewportRows,
          followBottom: stateRef.current.followBottom,
        };
        viewportSnapshotRef.current = { revision, snapshot };
        return snapshot;
      },
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
  onNotifyRef.current = onNotify;
  onRedrawViewportRef.current = onRedrawViewport;

  const repaintSelection = useCallback(() => {
    const selection = selectionRef.current;
    if (!selection) return;
    paintSelection(
      (data) => stdout.write(data),
      getFrameLines(),
      selection,
      stdout.columns ?? width ?? 80,
      getLastCursorPosition(),
    );
  }, [stdout, width]);

  const cancelScheduledSelectionRepaint = useCallback(() => {
    if (repaintImmediateRef.current === null) return;
    clearImmediate(repaintImmediateRef.current);
    repaintImmediateRef.current = null;
  }, []);

  const scheduleSelectionRepaint = useCallback(() => {
    if (!selectionRef.current || repaintImmediateRef.current !== null) return;
    repaintImmediateRef.current = setImmediate(() => {
      repaintImmediateRef.current = null;
      repaintSelection();
    });
  }, [repaintSelection]);

  const clearSelection = useCallback(() => {
    cancelScheduledSelectionRepaint();
    const selection = selectionRef.current;
    if (!selection) return;
    selectionRef.current = null;
    restoreSelection(
      (data) => stdout.write(data),
      getFrameLines(),
      selection,
      getLastCursorPosition(),
    );
  }, [cancelScheduledSelectionRepaint, stdout]);

  const replaceSelection = useCallback(
    (selection: SelectionRange) => {
      const current = selectionRef.current;
      if (current && selectionRangesEqual(current, selection)) return;
      clearSelection();
      selectionRef.current = selection;
      repaintSelection();
    },
    [clearSelection, repaintSelection],
  );

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
      // Coalesce a burst of terminal reports without a fixed frame delay.
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
    clearSelection();
    dragRef.current = null;
    applyScrollState(scrollTranscriptToEnd(metricsRef.current));
  }, [applyScrollState, cancelWheelScroll, clearSelection, followRequestKey]);

  useEffect(() => {
    if (!isActive) return;

    const viewportRowSpan = (): { top: number; bottom: number } | null => {
      if (!viewportRef.current) return null;
      const position = getAbsolutePosition(viewportRef.current);
      if (!position) return null;
      const rows = Math.max(1, Math.floor(measureElement(viewportRef.current).height));
      return { top: position.y + 1, bottom: position.y + rows };
    };

    const cancelDrag = () => {
      clearSelection();
      dragRef.current = null;
    };

    const toggleToolAt = (x: number, y: number) => {
      const toggleTool = onToggleToolRef.current;
      if (!toggleTool) return;

      const cellX = x - 1;
      const cellY = y - 1;
      for (const registration of toolRowsRef.current.values()) {
        if (!registration.expandable || !registration.element.current) continue;
        const rect = measureElement(registration.element.current);
        const position = getAbsolutePosition(registration.element.current);
        if (
          position &&
          cellX >= position.x &&
          cellX < position.x + rect.width &&
          cellY >= position.y &&
          cellY < position.y + rect.height
        ) {
          toggleTool(registration.id, registration.expanded);
          break;
        }
      }
    };

    const finishDragSelection = (range: SelectionRange) => {
      const frameLines = getFrameLines();
      if (frameLines.length === 0) {
        clearSelection();
        onRedrawViewportRef.current?.();
        return;
      }
      const text = extractSelectedText(frameLines, range);
      if (!text) return;
      void writeClipboard(text).then((outcome) => {
        onNotifyRef.current?.(
          outcome === 'clipboard'
            ? 'Copied selection to clipboard.'
            : outcome === 'terminal'
              ? 'Sent selection to the terminal clipboard.'
              : 'Selection copy was unavailable.',
        );
      });
    };

    const handleMouseInput = (input: string) => {
      const events = parseSgrMouseEvents(input);
      if (events.length === 0) return;

      for (const event of events) {
        if (event.type === 'wheel') {
          if (dragRef.current || selectionRef.current) cancelDrag();
          const rows = event.button === 'wheel-up' ? -MOUSE_WHEEL_ROWS : MOUSE_WHEEL_ROWS;
          if (rows < 0 && stateRef.current.scrollTop === 0 && historyLoaderRef.current?.('page')) {
            continue;
          }
          scheduleWheelScroll(rows);
          continue;
        }

        if (event.shift) {
          if (event.type === 'press') cancelDrag();
          continue;
        }
        if (event.button !== 'left') continue;

        if (event.type === 'press') {
          clearSelection();
          dragRef.current = null;
          const span = viewportRowSpan();
          if (!span || event.y < span.top || event.y > span.bottom) continue;
          dragRef.current = {
            anchor: { x: event.x, y: event.y },
            focus: { x: event.x, y: event.y },
            dragged: false,
          };
          continue;
        }

        const drag = dragRef.current;
        if (!drag) continue;

        if (event.type === 'move') {
          if (event.x !== drag.anchor.x || event.y !== drag.anchor.y) drag.dragged = true;
          if (!drag.dragged) continue;
          const span = viewportRowSpan();
          const focusY = span ? Math.min(Math.max(event.y, span.top), span.bottom) : event.y;
          drag.focus = { x: event.x, y: focusY };
          const range = normalizeSelectionRange(drag.anchor, drag.focus);
          replaceSelection(range);
          continue;
        }

        if (event.type !== 'release') continue;
        dragRef.current = null;
        const moved = drag.dragged || event.x !== drag.anchor.x || event.y !== drag.anchor.y;
        const span = viewportRowSpan();
        const focusY = span ? Math.min(Math.max(event.y, span.top), span.bottom) : event.y;
        drag.focus = { x: event.x, y: focusY };
        if (!moved) {
          toggleToolAt(event.x, event.y);
          continue;
        }
        const range = normalizeSelectionRange(drag.anchor, drag.focus);
        replaceSelection(range);
        finishDragSelection(range);
      }
    };

    const unsubscribeFrameUpdates = subscribeToFrameUpdates(scheduleSelectionRepaint);
    internal_eventEmitter.on('input', handleMouseInput);
    return () => {
      unsubscribeFrameUpdates();
      internal_eventEmitter.removeListener('input', handleMouseInput);
      cancelWheelScroll();
      if (dragRef.current || selectionRef.current) cancelDrag();
    };
  }, [
    cancelWheelScroll,
    clearSelection,
    internal_eventEmitter,
    isActive,
    replaceSelection,
    scheduleSelectionRepaint,
    scheduleWheelScroll,
  ]);

  useEffect(() => {
    const handleResize = () => {
      clearSelection();
      dragRef.current = null;
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [clearSelection, stdout]);

  useInput(
    (input, key) => {
      const inputWithoutMouse = stripSgrMouseSequences(input);
      if (inputWithoutMouse !== input && inputWithoutMouse.length === 0) return;
      if (key.eventType === 'release') return;
      clearSelection();
      dragRef.current = null;
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
