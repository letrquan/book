import { Box, Text } from 'ink';
import { basename } from 'path';
import type React from 'react';
import { useGradientSpinner, useStaggeredReveal, useTypewriter } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';
import { AsciiBanner } from './AsciiBanner.js';
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
  /** When false, the welcome banner is shown but animations are frozen
   *  (typewriter, gradient spinner, staggered reveal all settle to their
   *  final static state). Used to keep the banner pinned once the
   *  conversation has started without perpetual motion. */
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
  commandCount = 0,
  skillCount = 0,
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
  const reveal = useStaggeredReveal(tiny ? 3 : compact ? 5 : 8, animate, 110, motionDisabled);
  const tagline = useTypewriter('Your coding workspace, indexed.', 18, !tiny && animate, motionDisabled);
  const spinner = useGradientSpinner(animate, 'dots', motionDisabled);
  const contentWidth = Math.max(10, width - 2);

  if (screenReader) {
    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Text bold>BOOK</Text>
        <Text>{truncateDisplay('Your coding workspace, indexed.', contentWidth)}</Text>
        <Text>{truncateDisplay(`Workspace ${workspaceName(workspace)}. Model ${model}. Mode ${mode}.`, contentWidth)}</Text>
        <Text>{truncateDisplay('Type /help for commands, Ctrl+/ for shortcuts, @file for context, !cmd for shell.', contentWidth)}</Text>
      </Box>
    );
  }

  if (tiny) {
    return (
      <Box flexDirection="column" paddingX={1} width={width}>
        <Text color={theme.brand} bold>BOOK</Text>
        <WelcomeLine visible={reveal >= 1}>
          <Text color={theme.text}>{truncateDisplay('Ask anything, or type /help', contentWidth)}</Text>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 2}>
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
        <Text color={theme.brand} bold>BOOK</Text>
        <WelcomeLine visible={reveal >= 1}>
          <Text color={theme.text}>{truncateDisplay(tagline || ' ', contentWidth)}</Text>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 2}>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(`${workspaceName(workspace)} · ${model} · ${mode}`, contentWidth)}
          </Text>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 3}>
          <Text color={theme.brand}>/help</Text>
          <Text color={theme.subtle}> commands · </Text>
          <Text color={theme.brand}>/skills</Text>
          <Text color={theme.subtle}> workflows · </Text>
          <Text color={theme.brand}>@file</Text>
          <Text color={theme.subtle}> context</Text>
        </WelcomeLine>
        <WelcomeLine visible={reveal >= 4}>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(`Index ready: ${commandCount} commands · ${skillCount} skills`, contentWidth)}
          </Text>
        </WelcomeLine>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <AsciiBanner />
      <Text color={theme.brand} bold>BOOK</Text>
      <WelcomeLine visible={reveal >= 1}>
        <Text color={spinner.color}>{spinner.frame} </Text>
        <Text color={theme.text}>{truncateDisplay(tagline || ' ', contentWidth - 2)}</Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 2}>
        <Text color={theme.subtle} dimColor>
          {truncateDisplay(`Cover: ${workspaceName(workspace)} · ${model} · mode ${mode}`, contentWidth)}
        </Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 3}>
        <Text color={theme.brand}>Open a page</Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 4}>
        <Text color={theme.brand}>  /init</Text>
        <Text color={theme.subtle}> project memory  </Text>
        <Text color={theme.brand}>/skills</Text>
        <Text color={theme.subtle}> workflows  </Text>
        <Text color={theme.brand}>/review</Text>
        <Text color={theme.subtle}> current diff</Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 5}>
        <Text color={theme.subtle}>Ctrl+/ shortcuts · Shift+Tab mode · @file context · !cmd shell</Text>
      </WelcomeLine>
      <WelcomeLine visible={reveal >= 6}>
        <Text color={theme.subtle} dimColor>
          {truncateDisplay(`Index ready: ${commandCount} commands · ${skillCount} skills`, contentWidth)}
        </Text>
      </WelcomeLine>
    </Box>
  );
}
