import { Box, Text } from 'ink';
import { basename } from 'path';
import type React from 'react';
import { useStaggeredReveal } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { Bookplate } from './Bookplate.js';
import { truncateDisplay } from './word-wrap.js';

interface WelcomeScreenProps {
  terminalWidth: number;
  terminalHeight: number;
  workspace?: string;
  model?: string;
  mode?: string;
  commandCount?: number;
  skillCount?: number;
  reducedMotion?: boolean;
  screenReader?: boolean;
  /** When false, the welcome bookplate renders directly in its settled state. */
  animate?: boolean;
}

function workspaceName(workspace?: string): string {
  if (!workspace) return 'workspace';
  return basename(workspace) || workspace;
}

function WelcomeLine({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return <Box>{visible ? children : <Text> </Text>}</Box>;
}

export function WelcomeScreen({
  terminalWidth,
  terminalHeight,
  workspace,
  model = 'model',
  mode = 'default',
  reducedMotion = false,
  screenReader = false,
  animate = true,
}: WelcomeScreenProps) {
  const theme = useTheme();
  const width = Math.max(20, Math.floor(terminalWidth));
  const height = Math.max(8, Math.floor(terminalHeight));
  const compact = width < 64 || height < 18;
  const tiny = width < 42 || height < 12;
  const motionDisabled = reducedMotion || screenReader || !animate;
  const reveal = useStaggeredReveal(tiny ? 2 : compact ? 3 : 4, animate, 110, motionDisabled);
  const tagline = 'Your coding workspace, indexed.';
  const contentWidth = Math.max(10, width - 2);

  if (screenReader) {
    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Text bold>BOOK</Text>
        <Text>{truncateDisplay('Your coding workspace, indexed.', contentWidth)}</Text>
        <Text>
          {truncateDisplay(
            `Workspace ${workspaceName(workspace)}. Model ${model}. Mode ${mode}.`,
            contentWidth,
          )}
        </Text>
        <Text>
          {truncateDisplay(
            'Type /help for commands, Ctrl+/ for shortcuts, @file for context, !cmd for shell.',
            contentWidth,
          )}
        </Text>
      </Box>
    );
  }

  if (tiny) {
    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Text color={theme.assistantAccent} bold>
          BOOK <Text color={theme.toolRail}>·</Text>{' '}
          <Text color={theme.text}>
            {truncateDisplay('Ask anything, or type /help', contentWidth - 7)}
          </Text>
        </Text>
        <WelcomeLine visible={reveal >= 1}>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay('Ctrl+/ shortcuts · Shift+Tab mode', contentWidth)}
          </Text>
        </WelcomeLine>
      </Box>
    );
  }

  if (compact) {
    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Text color={theme.assistantAccent} bold>
          BOOK <Text color={theme.toolRail}>·</Text>{' '}
          <Text color={theme.text}>{truncateDisplay(tagline, contentWidth - 7)}</Text>
        </Text>
        <WelcomeLine visible={reveal >= 1}>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(`${workspaceName(workspace)} · ${model} · ${mode}`, contentWidth)}
          </Text>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 2}>
          <Text color={theme.brand}>/help</Text>
          <Text color={theme.subtle}> commands · </Text>
          <Text color={theme.brand}>/skills</Text>
          <Text color={theme.subtle}> workflows · </Text>
          <Text color={theme.brand}>@file</Text>
          <Text color={theme.subtle}> context</Text>
        </WelcomeLine>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Bookplate tagline={tagline} width={contentWidth} />
      <WelcomeLine visible={reveal >= 1}>
        <Text color={theme.subtle} dimColor>
          {truncateDisplay(`${workspaceName(workspace)} · ${model} · ${mode}`, contentWidth)}
        </Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 2}>
        <Text color={theme.brand}>/help</Text>
        <Text color={theme.subtle}> commands · </Text>
        <Text color={theme.brand}>/skills</Text>
        <Text color={theme.subtle}> workflows · </Text>
        <Text color={theme.brand}>@file</Text>
        <Text color={theme.subtle}> context · Ctrl+/ shortcuts</Text>
      </WelcomeLine>
    </Box>
  );
}
