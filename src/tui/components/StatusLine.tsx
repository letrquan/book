import { Box, Text } from 'ink';
import { usePulse } from '../hooks/useAnimation.js';
import { useGitStatus } from '../hooks/useGitStatus.js';

interface StatusLineProps {
  model: string;
  currentTurn: number;
  maxTurns: number;
  tokenCount: number;
  maxTokens?: number;
  workspace: string;
}

export function StatusLine({ model, currentTurn, maxTurns, tokenCount, maxTokens = 128000, workspace }: StatusLineProps) {
  const gitStatus = useGitStatus(workspace);
  const nearLimit = maxTokens > 0 && tokenCount > maxTokens * 0.8;
  const blink = usePulse(nearLimit && tokenCount > 0, 500);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray">model: </Text>
      <Text color="white">{model}</Text>
      <Text color="gray"> {'\u2502'} turn </Text>
      <Text color="white">{currentTurn}/{maxTurns}</Text>
      <Text color="gray"> {'\u2502'} tokens </Text>
      <Text color={nearLimit && blink ? 'red' : 'white'}>
        {(tokenCount / 1000).toFixed(1)}k/{maxTokens > 0 ? `${(maxTokens / 1000).toFixed(0)}k` : '?'}
      </Text>
      <Text color="gray"> {'\u2502'} </Text>
      <Text color="white">{gitStatus.branch}</Text>
      <Text color="gray"> {gitStatus.status}</Text>
    </Box>
  );
}
