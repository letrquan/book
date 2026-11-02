import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { createRenderDebugLogger } from '../../debug-log.js';
import { composeStartupAssembleFrame, STARTUP_ASSEMBLE_TOTAL_TICKS } from '../startup-assemble.js';
import { useTheme } from '../theme.js';
import { useUiClock } from '../ui-clock.js';

const assembleLog = createRenderDebugLogger('tui:startup-assemble');

interface StartupAssembleProps {
  width: number;
  height: number;
  onComplete: () => void;
}

export function StartupAssemble({ width, height, onComplete }: StartupAssembleProps) {
  const theme = useTheme();
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  const completedRef = useRef(false);
  const clock = useUiClock('cinematic', tick < STARTUP_ASSEMBLE_TOTAL_TICKS);

  useEffect(() => {
    assembleLog.event('start', { width: safeWidth, height: safeHeight });
    return () => assembleLog.event('stop', { tick: tickRef.current });
    // Only log the lifecycle, not every animation tick.
  }, []);

  useEffect(() => {
    if (tickRef.current >= STARTUP_ASSEMBLE_TOTAL_TICKS) return;
    tickRef.current += 1;
    setTick(tickRef.current);
  }, [clock]);

  useEffect(() => {
    if (tick < STARTUP_ASSEMBLE_TOTAL_TICKS || completedRef.current) return;
    completedRef.current = true;
    assembleLog.event('complete', { width: safeWidth, height: safeHeight });
    onComplete();
  }, [onComplete, safeHeight, safeWidth, tick]);

  const frame = composeStartupAssembleFrame(safeWidth, safeHeight, tick, theme);
  return (
    <Box flexDirection="column" width={safeWidth} height={safeHeight} overflow="hidden">
      {frame.rows.map((runs, rowIndex) => (
        <Box key={rowIndex} width={safeWidth} height={1} flexShrink={0}>
          {runs.map((run, runIndex) => (
            <Text
              key={runIndex}
              color={run.color}
              backgroundColor={run.backgroundColor}
              bold={run.bold}
              dimColor={run.dimColor}
            >
              {run.text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
