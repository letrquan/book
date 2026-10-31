import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { frameGrid, PANEL_CHROME } from '../layout.js';
import { SECTION_SIGN } from '../marks.js';
import { useTheme } from '../theme.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

/** The edge a dialog hangs from: a row of upper eighth blocks, as Claude Code draws it. */
export const DIALOG_EDGE = '▔';

/**
 * Rows a dialog spends besides its body: the edge, the title, the row of air under it, the row of
 * air over the keys, and the keys.
 */
export const DIALOG_CHROME_ROWS = 5;

const DIALOG_CLOSE_KEYS = 'Esc to close';
const DIALOG_SCROLL_KEYS = '↑/↓ to scroll';

/**
 * A reference sheet as Claude Code shows one: in the composer's place at the foot of the screen,
 * with the prompt and the status line put away until it closes.
 *
 *   ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
 *     § Cost
 *
 *     120 tokens (100 in, 20 out) · …
 *
 *     Esc to close
 *
 * The keys sit right under the body, where the prompt was, so the way out is where the eye already
 * is. A body taller than `maxBodyRows` opens at its top and scrolls inside the dialog, and the keys
 * say so. Esc itself is the app's to handle: it outranks a running turn while a dialog is up.
 */
export function Dialog({
  title,
  meta,
  terminalWidth,
  maxBodyRows,
  scrollable = true,
  screenReader = false,
  onLayoutChange,
  children,
}: {
  title: string;
  /** A quiet note at the far end of the title row (`42 commands`). */
  meta?: string;
  terminalWidth: number;
  /** The most rows the body may take before it scrolls. */
  maxBodyRows: number;
  /**
   * Whether the dialog scrolls its body. A body that is a list of its own (the permission rules)
   * takes the arrows itself, so it is laid out whole instead.
   */
  scrollable?: boolean;
  screenReader?: boolean;
  /** Called when the dialog's height changes, so the transcript above re-measures its viewport. */
  onLayoutChange?: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  const frame = frameGrid(terminalWidth);
  const innerWidth = Math.max(1, frame.width - PANEL_CHROME);
  const [overflowing, setOverflowing] = useState(false);
  const keys = [overflowing ? DIALOG_SCROLL_KEYS : null, DIALOG_CLOSE_KEYS]
    .filter((key): key is string => key !== null)
    .join(' · ');

  if (screenReader) {
    return (
      <Box flexDirection="column" width={frame.width} marginX={frame.marginX}>
        <Text>{meta ? `${title} · ${meta}` : title}</Text>
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
        <Box marginTop={1}>
          <Text>{DIALOG_CLOSE_KEYS}</Text>
        </Box>
      </Box>
    );
  }

  const label = `${SECTION_SIGN} `;
  const note = meta ? truncateDisplay(meta, Math.max(0, Math.floor(innerWidth / 2))) : '';
  const titleRoom = Math.max(
    1,
    innerWidth - displayWidth(label) - (note ? displayWidth(note) + 2 : 0),
  );
  return (
    <Box flexDirection="column" width={frame.width} marginX={frame.marginX} flexShrink={0}>
      <Text color={theme.permission}>{DIALOG_EDGE.repeat(frame.width)}</Text>
      <Box paddingX={PANEL_CHROME / 2} width={frame.width} justifyContent="space-between">
        <Text>
          <Text color={theme.brand}>{label}</Text>
          <Text bold color={theme.permission}>
            {truncateDisplay(title, titleRoom)}
          </Text>
        </Text>
        {note ? <Text color={theme.inactive}>{note}</Text> : null}
      </Box>
      <Box paddingX={PANEL_CHROME / 2} marginTop={1} flexDirection="column">
        {scrollable ? (
          <ScrollBody
            maxRows={maxBodyRows}
            width={innerWidth}
            onOverflowChange={setOverflowing}
            onLayoutChange={onLayoutChange}
          >
            {children}
          </ScrollBody>
        ) : (
          children
        )}
      </Box>
      <Box paddingX={PANEL_CHROME / 2} marginTop={1}>
        <Text color={theme.inactive} italic>
          {keys}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * The body of a dialog, at most `maxRows` tall: a taller one is clipped to a window that opens at
 * its top and moves on ↑/↓, PgUp/PgDn and Home/End, the way the transcript's own viewport works.
 */
function ScrollBody({
  maxRows,
  width,
  onOverflowChange,
  onLayoutChange,
  children,
}: {
  maxRows: number;
  width: number;
  onOverflowChange: (overflowing: boolean) => void;
  onLayoutChange?: () => void;
  children: ReactNode;
}) {
  const contentRef = useRef<DOMElement>(null);
  const [contentRows, setContentRows] = useState(0);
  const [top, setTop] = useState(0);
  const rowsAllowed = Math.max(1, maxRows);
  const viewportRows = Math.min(contentRows, rowsAllowed);
  const lastTop = Math.max(0, contentRows - viewportRows);
  const shownTop = Math.min(top, lastTop);
  const overflowing = contentRows > rowsAllowed;

  // Measured after every commit: the body is whatever the caller passed, and only its laid-out
  // height says how tall it is.
  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const rows = Math.max(0, Math.floor(measureElement(contentRef.current).height));
    if (rows !== contentRows) setContentRows(rows);
  });
  useLayoutEffect(() => {
    onOverflowChange(overflowing);
  }, [onOverflowChange, overflowing]);
  useLayoutEffect(() => {
    onLayoutChange?.();
  }, [onLayoutChange, viewportRows]);

  useInput(
    (_input, key) => {
      const page = Math.max(1, viewportRows - 1);
      const move = (next: number) => setTop(Math.max(0, Math.min(lastTop, next)));
      if (key.upArrow) move(shownTop - 1);
      else if (key.downArrow) move(shownTop + 1);
      else if (key.pageUp) move(shownTop - page);
      else if (key.pageDown) move(shownTop + page);
      else if (key.home) move(0);
      else if (key.end) move(lastTop);
    },
    { isActive: overflowing },
  );

  return (
    <Box height={viewportRows} width={width} overflowY="hidden" flexDirection="column">
      <Box
        ref={contentRef}
        position="absolute"
        flexDirection="column"
        flexShrink={0}
        width={width}
        marginTop={-shownTop}
      >
        {children}
      </Box>
    </Box>
  );
}
