import { Box, Text } from 'ink';
import { usePulse } from '../hooks/useAnimation.js';
import { useGitStatus } from '../hooks/useGitStatus.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types.js';

interface StatusLineProps {
  model: string;
  currentTurn: number;
  maxTurns: number;
  tokenCount: number;
  maxTokens?: number;
  workspace: string;
  mode: PermissionMode;
  taskCount: number;
  activeTaskCount: number;
}

export function StatusLine({
  model,
  currentTurn,
  maxTurns,
  tokenCount,
  maxTokens = 128000,
  workspace,
  mode,
  taskCount,
  activeTaskCount,
}: StatusLineProps) {
  const theme = useTheme();
  const gitStatus = useGitStatus(workspace);
  const nearLimit = maxTokens > 0 && tokenCount > maxTokens * 0.8;
  const blink = usePulse(nearLimit && tokenCount > 0, 500);

  return (
    <Box borderStyle="single" borderColor={theme.subtle} paddingX={1}>
      <Text color={theme.subtle}>model: </Text>
      <Text color={theme.text}>{model}</Text>
      <Text color={theme.subtle}> {'│'} turn </Text>
      <Text color={theme.text}>{currentTurn}/{maxTurns}</Text>
      <Text color={theme.subtle}> {'│'} tokens </Text>
      <Text color={nearLimit && blink ? theme.usageMeterCritical : theme.text}>
        {(tokenCount / 1000).toFixed(1)}k/{maxTokens > 0 ? `${(maxTokens / 1000).toFixed(0)}k` : '?'}
      </Text>
      <Text color={theme.subtle}> {'│'} mode </Text>
      <Text color={theme.promptBorder}>{mode}</Text>
      <Text color={theme.subtle}> {'│'} </Text>
      <Text color={theme.text}>{gitStatus.branch}</Text>
      <Text color={theme.subtle}> {gitStatus.status}</Text>
      {taskCount > 0 && (
        <>
          <Text color={theme.subtle}> {'│'} </Text>
          <Text color={theme.text}>
            {activeTaskCount > 0 ? `${activeTaskCount}/` : ''}{taskCount} tasks
          </Text>
        </>
      )}
    </Box>
  );
}
