import { Box, Text, measureElement, useInput, useStdin, useStdout, type DOMElement } from 'ink';
import type { EventEmitter } from 'node:events';
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
  createWheelMotion,
  getTranscriptHalfPageRows,
  getTranscriptPageRows,
  halfPageScrollDirection,
  reconcileTranscriptScroll,
  scrollTranscriptBy,
  scrollTranscriptToEnd,
  scrollTranscriptToStart,
  wheelEaseStep,
  wheelRows,
  type TranscriptMetrics,
  type TranscriptScrollState,
  type WheelMotion,
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
import { resolveInkMaxFps } from '../../cli/tui-renderer-mode.js';
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
  /**
   * True while nothing on screen is holding a text editor's focus, and only then
   * may this transcript read Ctrl+U and Ctrl+D as its own half-page scrolls.
   * Derive it with `pagerChordsAvailable` from `../transcript-scroll.js`.
   *
   * Ctrl+U and Ctrl+D are readline's kills, and Ink hands every key to every
   * handler, so this transcript cannot decide the question on its own: by the
   * time its own handler runs, an editor has already acted, and a draft that
   * Ctrl+U itself emptied looks exactly like one that was empty all along. So
   * the editor takes the chord and, when it had nothing to edit, hands it back
   * through `scrollRequest` — and this transcript's own Ctrl+U / Ctrl+D handling
   * is for the times no editor is taking keys at all (a permission prompt, a
   * sheet of choices), which is when a scroll is the only thing the key can mean.
   *
   * A sheet with its own editor open reports through the same channel as its
   * height, so plan approval, the `Other` answer and an MCP text field take
   * these keys the way the composer does.
   */
  pagerChordsAvailable?: boolean;
  /**
   * A half-page scroll the app asked for on the composer's behalf. Keyed so a
   * repeated request scrolls again; the initial `key: 0` is treated as none.
   */
  scrollRequest?: TranscriptScrollRequest;
  onToggleTool?: (toolId: string, expanded: boolean) => void;
  onNotify?: (message: string) => void;
  onRedrawViewport?: () => void;
}

/** A half-page scroll asked for from outside, as the composer reports it. */
export interface TranscriptScrollRequest {
  key: number;
  direction: 'up' | 'down';
}

const INITIAL_METRICS: TranscriptMetrics = { contentRows: 0, viewportRows: 1 };
/**
 * Between wheel animation frames: a millisecond under the frame interval Ink draws at
 * (`installInkFrameThrottle`). A draw other commits scheduled for the same frame then fires after
 * the step and shows it, instead of drawing just before it and leaving the step for the frame after.
 */
const WHEEL_FRAME_MS = Math.ceil(1000 / resolveInkMaxFps(process.platform)) - 1;

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
  // True by default: a transcript on its own has no editor to take these keys,
  // and the chords are the only thing they can mean. `app.tsx` passes the real
  // answer for the whole screen.
  pagerChordsAvailable = true,
  scrollRequest,
  onToggleTool,
  onNotify,
  onRedrawViewport,
}: TranscriptViewProps) {
  const theme = useTheme();
  // Mouse reports need Ink's raw input events: `useInput` strips the ESC prefix and parses them as
  // keys. Ink 7 still passes the emitter in the stdin context but no longer types it.
  const { internal_eventEmitter } = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: EventEmitter;
  };
  const { stdout } = useStdout();
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const metricsRef = useRef(INITIAL_METRICS);
  const stateRef = useRef<TranscriptScrollState>(createTranscriptScrollState());
  const previousContentRowsRef = useRef(0);
  const anchoredRowsRef = useRef(0);
  const previousFollowRequestRef = useRef(followRequestKey);
  // Seeded from the request in hand, the way `previousFollowRequestRef` is seeded
  // from `followRequestKey`. A remount is not a fresh request: `app.tsx` keys
  // this component on the session, so /resume and /clear mount a new one while
  // `scrollRequest` still carries the count from the session before. Starting at
  // 0 would replay that count and open the new session scrolled half a page back
  // and no longer following output.
  const previousScrollRequestRef = useRef(scrollRequest?.key ?? 0);
  const pendingWheelRowsRef = useRef(0);
  const wheelMotionRef = useRef<WheelMotion>(createWheelMotion());
  const wheelImmediateRef = useRef<ReturnType<typeof setImmediate> | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const publishViewport = useCallback((state: TranscriptScrollState) => {
    const viewportRows = metricsRef.current.viewportRows;
    const bucketRows = Math.max(1, getTranscriptHalfPageRows(viewportRows));
    const bucket = `${Math.floor(state.scrollTop / bucketRows)}:${viewportRows}:${state.followBottom}`;
    if (viewportBucketRef.current === bucket) return;

    viewportBucketRef.current = bucket;
    viewportRevisionRef.current++;
    for (const listener of viewportListenersRef.current) listener();
  }, []);
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
      anchorRowsAbove: (endRow, deltaRows) => {
        // Following the tail pins the view to the bottom anyway, and a row that reaches into the
        // view changed what the reader is looking at, so the view stays where it is.
        const state = stateRef.current;
        if (state.followBottom || deltaRows === 0 || endRow > state.scrollTop) return;
        // Not clamped: the content grows in the same commit, and the next measure reconciles.
        const next = { ...state, scrollTop: Math.max(0, state.scrollTop + deltaRows) };
        anchoredRowsRef.current += deltaRows;
        stateRef.current = next;
        setRenderedScrollTop(next.scrollTop);
        publishViewport(next);
      },
    }),
    [publishViewport],
  );

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
    wheelMotionRef.current = createWheelMotion();
    if (wheelImmediateRef.current !== null) {
      clearImmediate(wheelImmediateRef.current);
      wheelImmediateRef.current = null;
    }
    if (wheelTimerRef.current !== null) {
      clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = null;
    }
  }, []);

  // One animation frame of wheel motion. Reports only move the target (`pendingWheelRowsRef`);
  // this is the one place a wheel scroll is committed, so a burst of reports costs one commit per
  // frame and the frame gets Ink's render slot.
  const stepWheelScroll = useCallback(() => {
    wheelImmediateRef.current = null;
    wheelTimerRef.current = null;
    const rows = wheelEaseStep(pendingWheelRowsRef.current);
    // Less than a row left: keep the remainder for the next report.
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
    if (wheelEaseStep(pendingWheelRowsRef.current) !== 0) {
      wheelTimerRef.current = setTimeout(stepWheelScroll, WHEEL_FRAME_MS);
    }
  }, [applyScrollState]);

  const scheduleWheelScroll = useCallback(
    (direction: -1 | 1) => {
      const { rows, motion } = wheelRows(wheelMotionRef.current, direction, performance.now());
      wheelMotionRef.current = motion;
      // A report against the motion drops what is left of it instead of fighting it.
      if (Math.sign(pendingWheelRowsRef.current) === -direction) pendingWheelRowsRef.current = 0;
      pendingWheelRowsRef.current += rows;
      if (wheelImmediateRef.current !== null || wheelTimerRef.current !== null) return;
      // Idle: the first frame goes out at once, so a lone notch draws without waiting on a timer.
      wheelImmediateRef.current = setImmediate(stepWheelScroll);
    },
    [stepWheelScroll],
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

    // Rows the view was anchored past grew above it, as history was measured on the way up; they
    // are not new output below.
    const grownRows = contentRows - previousContentRowsRef.current - anchoredRowsRef.current;
    anchoredRowsRef.current = 0;
    if (grownRows > 0 && !stateRef.current.followBottom && previousContentRowsRef.current > 0) {
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

  const scrollByHalfPage = useCallback(
    (direction: 'up' | 'down') => {
      const metrics = metricsRef.current;
      if (
        direction === 'up' &&
        stateRef.current.scrollTop === 0 &&
        historyLoaderRef.current?.('page')
      )
        return;
      cancelWheelScroll();
      const rows = getTranscriptHalfPageRows(metrics.viewportRows);
      applyScrollState(
        scrollTranscriptBy(stateRef.current, metrics, direction === 'up' ? -rows : rows),
      );
    },
    [applyScrollState, cancelWheelScroll],
  );

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

  // A chord the composer had no draft to edit. It arrives as a request rather
  // than as a keypress, because by the time every handler has run there is no
  // telling which of the two the key was meant for.
  useLayoutEffect(() => {
    if (!isActive || !scrollRequest) return;
    if (previousScrollRequestRef.current === scrollRequest.key) return;
    previousScrollRequestRef.current = scrollRequest.key;
    scrollByHalfPage(scrollRequest.direction);
  }, [isActive, scrollByHalfPage, scrollRequest]);

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
          const direction = event.button === 'wheel-up' ? -1 : 1;
          if (
            direction < 0 &&
            stateRef.current.scrollTop === 0 &&
            historyLoaderRef.current?.('page')
          ) {
            continue;
          }
          scheduleWheelScroll(direction);
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
    if (internal_eventEmitter) {
      internal_eventEmitter.on('input', handleMouseInput);
    }
    return () => {
      unsubscribeFrameUpdates();
      internal_eventEmitter?.removeListener('input', handleMouseInput);
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
      // Rows rewrap at the new width, so a glide measured in the old rows would land elsewhere.
      cancelWheelScroll();
    };
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [cancelWheelScroll, clearSelection, stdout]);

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
      } else if (pagerChordsAvailable && halfPageScrollDirection(input, key)) {
        // The pager chords reach this handler only when no editor is taking
        // keys — a permission prompt, a sheet of choices. There is then no draft
        // to edit, so a half-page scroll is the only thing the key can mean. With
        // an editor live they arrive as `scrollRequest` instead, because by the
        // time this handler runs the editor has already spent them.
        scrollByHalfPage(halfPageScrollDirection(input, key)!);
        return;
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
