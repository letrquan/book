import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { SHEET_COLUMN_GAP, sheetContentWidth } from '../layout.js';
import { builtinHelpGroups, type HelpEntry, type HelpGroup } from '../help-catalog.js';
import { SoftPanel } from './chrome.js';
import { displayWidth, padDisplay, truncateDisplay } from './word-wrap.js';

/**
 * Content width at which the groups flow into two columns. Below it the list
 * runs one column and grows taller than a 44-row terminal, so its head scrolled
 * away; at a 100-column terminal it now fits.
 */
const TWO_COLUMN_MIN = 88;

/** What the name column prints: the syntax only when there is room to spare. */
function entryLabel(entry: HelpEntry, showHints: boolean): { name: string; hint: string } {
  return {
    name: entry.name,
    hint: showHints && entry.argumentHint ? ` ${entry.argumentHint}` : '',
  };
}

/**
 * One name column for a whole column of groups, so descriptions line up down
 * the sheet instead of jumping with each group's longest syntax. It is capped,
 * and a longer syntax is cut, so one `/memory [status|inbox|…]` cannot push
 * every description to the far edge.
 */
function nameColumnWidth(groups: readonly HelpGroup[], width: number, showHints: boolean): number {
  const widest = Math.max(
    1,
    ...groups.flatMap((group) =>
      group.entries.map((entry) => {
        const label = entryLabel(entry, showHints);
        return displayWidth(label.name + label.hint);
      }),
    ),
  );
  return Math.min(widest, Math.max(12, Math.floor(width * 0.42)));
}

function GroupBlock({
  group,
  width,
  nameWidth,
  showHints,
}: {
  group: HelpGroup;
  width: number;
  nameWidth: number;
  showHints: boolean;
}) {
  const theme = useTheme();
  const descWidth = Math.max(8, width - nameWidth - 2);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.subtle}>
        {group.title}
      </Text>
      {group.entries.map((entry: HelpEntry) => {
        const label = entryLabel(entry, showHints);
        const shownName = truncateDisplay(label.name, nameWidth);
        const shownHint = truncateDisplay(
          label.hint,
          Math.max(0, nameWidth - displayWidth(shownName)),
        );
        return (
          <Box key={entry.name}>
            <Text color={theme.text}>{shownName}</Text>
            <Text color={theme.inactive}>
              {padDisplay(shownHint, nameWidth - displayWidth(shownName))}
            </Text>
            <Text
              color={theme.inactive}
            >{`  ${truncateDisplay(entry.description, descWidth)}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * /help: every built-in command, generated from the command registry and set
 * in groups, with the name in ink and its syntax and description quiet, in
 * aligned columns. Custom commands follow in their own group. From a
 * 92-column terminal the groups flow into two columns, so the list fits on
 * one screen.
 */
export function HelpPanel({
  width,
  customCommands = [],
}: {
  width: number;
  customCommands?: ReadonlyArray<{ name: string; description: string; argumentHint?: string }>;
}) {
  const groups = builtinHelpGroups();
  if (customCommands.length > 0) {
    groups.push({
      title: 'Custom',
      entries: customCommands.map((command) => ({
        name: `/${command.name}`,
        argumentHint: command.argumentHint,
        description: command.description,
      })),
    });
  }
  const count = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const contentWidth = sheetContentWidth(width, 20);
  const twoColumns = contentWidth >= TWO_COLUMN_MIN;
  const columnWidth = twoColumns ? Math.floor((contentWidth - SHEET_COLUMN_GAP) / 2) : contentWidth;
  // Split so both columns hold about the same number of rows.
  const rowsOf = (group: HelpGroup) => group.entries.length + 2;
  const total = groups.reduce((sum, group) => sum + rowsOf(group), 0);
  let running = 0;
  const left: HelpGroup[] = [];
  const right: HelpGroup[] = [];
  for (const group of groups) {
    if (!twoColumns || running + rowsOf(group) / 2 <= total / 2) left.push(group);
    else right.push(group);
    running += rowsOf(group);
  }
  // Two columns leave no room for the syntax; the command menu shows it on
  // the row you land on, which is where it is needed.
  const showHints = !twoColumns;
  const column = (list: HelpGroup[]) => {
    const nameWidth = nameColumnWidth(list, columnWidth, showHints);
    return list.map((group) => (
      <GroupBlock
        key={group.title}
        group={group}
        width={columnWidth}
        nameWidth={nameWidth}
        showHints={showHints}
      />
    ));
  };
  return (
    <SoftPanel title="Commands" meta={`${count} · Esc to close`} width={width}>
      <Box columnGap={SHEET_COLUMN_GAP}>
        <Box flexDirection="column" width={columnWidth}>
          {column(left)}
        </Box>
        {twoColumns ? (
          <Box flexDirection="column" width={columnWidth}>
            {column(right)}
          </Box>
        ) : null}
      </Box>
    </SoftPanel>
  );
}
