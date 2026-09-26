import { Text } from 'ink';
import { useMemo } from 'react';
import { useTheme } from '../theme.js';
import type { SkillMentionCandidate } from '../../input/skill-mentions.js';
import { getCommandMenuWindow } from './CommandMenu.js';
import { floatingFrameMetrics, MenuRow, SoftPanel } from './chrome.js';
import { frameGrid } from '../layout.js';

interface SkillMentionMenuProps {
  items: SkillMentionCandidate[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
  terminalWidth?: number;
  maxRows?: number;
  compact?: boolean;
  screenReader?: boolean;
}

/** Skill picker for explicit `$name` mentions. */
export function SkillMentionMenu({
  items,
  filterText,
  selectedIndex,
  visible,
  terminalWidth = 80,
  maxRows = 8,
  compact = false,
  screenReader = false,
}: SkillMentionMenuProps) {
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

  // The hairline spans the terminal like the composer's; rows keep the panel measure.
  return (
    <SoftPanel
      width={frameGrid(width).width}
      marginX={frame.marginX}
      attached
      title={filterText ? `Skills matching “${filterText}”` : 'Skills'}
      meta={`${items.length} ${items.length === 1 ? 'skill' : 'skills'}${hiddenTotal > 0 ? ' · type to filter' : ''}`}
    >
      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>
          No matching skills
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const globalIndex = window.start + index;
          const selected = globalIndex === selIdx;
          return (
            <MenuRow
              key={`${item.source}:${item.rootKind}:${item.name}:${globalIndex}`}
              selected={selected}
              name={`$${item.name}`}
              desc={compact ? '' : item.description}
              width={contentWidth}
              screenReader={screenReader}
            />
          );
        })
      )}
    </SoftPanel>
  );
}
