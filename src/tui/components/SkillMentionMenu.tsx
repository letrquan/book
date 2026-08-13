import { Text } from 'ink';
import { useMemo } from 'react';
import { usePulse } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import type { SkillMentionCandidate } from '../../input/skill-mentions.js';
import { truncateDisplay } from './word-wrap.js';
import { getCommandMenuWindow } from './CommandMenu.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';

interface SkillMentionMenuProps {
  items: SkillMentionCandidate[];
  filterText: string;
  selectedIndex: number;
  visible: boolean;
  terminalWidth?: number;
  maxRows?: number;
  compact?: boolean;
  reducedMotion?: boolean;
  screenReader?: boolean;
}

function formatSkillRow(
  item: SkillMentionCandidate,
  selected: boolean,
  width: number,
  compact: boolean,
  shimmer: boolean,
  screenReader: boolean,
): string {
  const marker = screenReader
    ? selected
      ? 'selected '
      : ''
    : selected
      ? shimmer
        ? '▸ '
        : '› '
      : '  ';
  const desc = item.description && !compact ? ` — ${item.description}` : '';
  return truncateDisplay(`${marker}$${item.name}${desc}`, width);
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
  reducedMotion = false,
  screenReader = false,
}: SkillMentionMenuProps) {
  const theme = useTheme();
  const shimmer = usePulse(visible && !reducedMotion && !screenReader, 360);
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

  return (
    <SoftPanel width={frame.width} marginX={frame.marginX}>
      <PanelTitle>
        {filterText ? truncateDisplay(`Skills matching “${filterText}”`, contentWidth) : 'Skills'}
      </PanelTitle>
      {items.length === 0 ? (
        <Text color={theme.subtle} dimColor>
          No matching skills
        </Text>
      ) : (
        visibleItems.map((item, index) => {
          const globalIndex = window.start + index;
          const selected = globalIndex === selIdx;
          return (
            <SelectionRow
              key={`${item.source}:${item.rootKind}:${item.name}:${globalIndex}`}
              selected={selected}
              width={contentWidth}
            >
              {formatSkillRow(item, selected, contentWidth, compact, shimmer, screenReader)}
            </SelectionRow>
          );
        })
      )}
      {hiddenTotal > 0 ? (
        <Text color={theme.subtle} dimColor>
          {truncateDisplay(`… ${hiddenTotal} more, type to filter`, contentWidth)}
        </Text>
      ) : null}
    </SoftPanel>
  );
}
