import { Text, Box } from 'ink';
import { Spinner } from './Spinner.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isExpanded: boolean;
  onToggle: () => void;
  isPending?: boolean;
}

function getPrimaryArg(args: Record<string, unknown>): string {
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.command === 'string') return args.command.split('\n')[0];
  if (typeof args.pattern === 'string') return args.pattern;
  if (typeof args.message === 'string') return args.message;
  if (typeof args.old_string === 'string') return args.old_string.slice(0, 60);
  const keys = Object.keys(args);
  if (keys.length > 0) {
    const firstVal = args[keys[0]];
    return typeof firstVal === 'string' ? firstVal.slice(0, 60) : '';
  }
  return '';
}

function getResultLabel(result?: ToolResult): { label: string; color: string } {
  if (!result) return { label: '', color: 'gray' };
  if (result.error?.startsWith('SKIPPED')) return { label: '[SKIPPED]', color: 'yellow' };
  if (!result.success) return { label: '[ERR]', color: 'red' };
  return { label: '[OK]', color: 'green' };
}

function renderDiff(output: string): Array<{ text: string; bgColor?: string }> {
  const lines = output.split('\n');
  return lines.map((line) => {
    if (line.startsWith('+')) return { text: line, bgColor: 'green' };
    if (line.startsWith('-')) return { text: line, bgColor: 'red' };
    return { text: line };
  });
}

function isDiffOutput(toolName: string, result: ToolResult | undefined): boolean {
  if (!result?.success) return false;
  if (toolName !== 'edit_file' && toolName !== 'write_file') return false;
  const output = result.output;
  if (!output) return false;
  const plusLines = output.split('\n').filter((l) => l.startsWith('+')).length;
  const minusLines = output.split('\n').filter((l) => l.startsWith('-')).length;
  return plusLines > 0 || minusLines > 0;
}

export function ToolCallBlock({ name, args, result, isExpanded, onToggle, isPending }: ToolCallBlockProps) {
  const isRunning = !result && !isPending;
  const primaryArg = getPrimaryArg(args);
  const { label, color } = getResultLabel(result);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text color="magenta">
          {isExpanded ? '\u25bc' : '\u25b6'}{' '}
        </Text>
        {isRunning ? (
          <Spinner active style="dots" />
        ) : (
          <Text color={color}>{label} </Text>
        )}
        <Text color="magenta">{name}</Text>
        {primaryArg ? (
          <Text color="gray"> {primaryArg.slice(0, 60)}</Text>
        ) : null}
      </Box>
      {isExpanded && result && isDiffOutput(name, result) ? (
        renderDiff(result.output).map((line, i) => (
          <Box key={i} marginLeft={2}>
            <Text
              color={line.bgColor === 'green' ? 'green' : line.bgColor === 'red' ? 'red' : 'gray'}
            >
              {'\u2502'} {line.text.slice(0, 120)}
            </Text>
          </Box>
        ))
      ) : isExpanded && result?.output ? (
        result.output.split('\n').slice(0, 20).map((line, i) => (
          <Box key={i} marginLeft={2}>
            <Text color="gray">{'\u2502'} {line.slice(0, 120)}</Text>
          </Box>
        ))
      ) : null}
      {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
        <Box marginLeft={2}>
          <Text color="red">{'\u2502'} {result.error.slice(0, 120)}</Text>
        </Box>
      ) : null}
      {isPending ? (
        <Box marginLeft={2}>
          <Text color="yellow">[needs approval]</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export { isDiffOutput, getPrimaryArg, getResultLabel, renderDiff };
