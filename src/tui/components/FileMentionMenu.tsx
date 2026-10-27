import { Text } from 'ink';
import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import type { FileMentionCandidate } from '../../input/file-mentions.js';
import { getCommandMenuWindow } from './CommandMenu.js';
import { floatingFrameMetrics, MenuRow, SoftPanel } from './chrome.js';
import { frameGrid } from '../layout.js';

interface FileMentionMenuProps {
  items: FileMentionCandidate[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
  terminalWidth?: number;
  maxRows?: number;
  compact?: boolean;
  screenReader?: boolean;
}

function fileBadge(item: FileMentionCandidate, compact: boolean): string {
  if (item.kind === 'directory') return compact ? ' [D]' : ' [Directory]';
  if (item.kind === 'session') return compact ? ' [S]' : ' [Session]';
  return compact ? ' [F]' : ' [File]';
}

/** The menu's count: its live sessions (#620) when it offers any, then its files. */
function countMeta(sessions: number, files: number): string {
  const fileCount = `${files} ${files === 1 ? 'file' : 'files'}`;
  return sessions > 0
    ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'} · ${fileCount}`
    : fileCount;
}

/** Workspace file picker for @ mentions, with the live sessions it can name above the files. */
export function FileMentionMenu({
  items,
  filterText,
  selectedIndex,
  visible,
  terminalWidth = 80,
  maxRows = 8,
  compact = false,
  screenReader = false,
}: FileMentionMenuProps) {
  const theme = useTheme();

  const width = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(width);
  const contentWidth = Math.max(8, frame.width - 4);
  const safeMaxRows = Math.max(1, Math.floor(maxRows));
  const selIdx = Math.max(0, Math.min(selectedIndex, items.length - 1));
  const window = useMemo(
    () => getCommandMenuWindow(items.length, selIdx, safeMaxRows),
    [items.length, selIdx, safeMaxRows],
  );
  const visibleItems = items.slice(window.start, window.end);
  const hiddenTotal = window.start + Math.max(0, items.length - window.end);

  if (!visible) return null;

  const sessions = items.filter((item) => item.kind === 'session').length;
  const noun = sessions > 0 ? 'Mentions' : 'Files';
  const title = filterText ? `${noun} matching “${filterText}”` : noun;

  // The hairline spans the terminal like the composer's; rows keep the panel measure.
  return (
    <SoftPanel
      width={frameGrid(width).width}
      marginX={frame.marginX}
      attached
      title={title}
      meta={`${countMeta(sessions, items.length - sessions)}${hiddenTotal > 0 ? ' · type to filter' : ''}`}
    >
      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>
          No matching files
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const globalIndex = window.start + index;
          const isSelected = globalIndex === selIdx;
          return (
            <MenuRow
              key={`${item.kind}-${item.path}-${globalIndex}`}
              selected={isSelected}
              name={`@${item.path}`}
              badge={fileBadge(item, compact)}
              desc={compact ? '' : item.desc}
              width={contentWidth}
              screenReader={screenReader}
            />
          );
        })
      )}
    </SoftPanel>
  );
}
