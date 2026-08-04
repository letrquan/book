import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { createRenderDebugLogger } from '../../debug-log.js';
import {
  createBookRuneMask,
  STARTUP_FIRE_TOTAL_TICKS,
  StartupFireSimulation,
  startupFireStepOptions,
} from '../startup-fire.js';
import { composeStartupFireFrame } from '../startup-fire-frame.js';
import { useTheme } from '../theme.js';
import { useUiClock } from '../ui-clock.js';

const fireLog = createRenderDebugLogger('tui:startup-fire');

interface StartupFireProps {
  width: number;
  height: number;
  onComplete: () => void;
}

export function StartupFire({ width, height, onComplete }: StartupFireProps) {
  const theme = useTheme();
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const simulationRef = useRef(new StartupFireSimulation(safeWidth, safeHeight * 2));
  const [tick, setTick] = useState(0);
  const tickRef = useRef(0);
  const completedRef = useRef(false);
  const clock = useUiClock('cinematic', tick < STARTUP_FIRE_TOTAL_TICKS);

  useEffect(() => {
    fireLog.event('start', { width: safeWidth, height: safeHeight });
    return () => fireLog.event('stop', { tick: tickRef.current });
    // Only log the lifecycle, not every animation tick.
  }, []);

  useEffect(() => {
    const simulation = simulationRef.current;
    simulation.resize(safeWidth, safeHeight * 2);
    const currentTick = tickRef.current;
    if (currentTick >= STARTUP_FIRE_TOTAL_TICKS) return;
    const rune =
      currentTick >= 24 && currentTick < 44
        ? createBookRuneMask(safeWidth, safeHeight * 2).mask
        : undefined;
    const step = startupFireStepOptions(currentTick);
    simulation.step({ ...step, protectedMask: rune });
    simulation.step({ ...step, protectedMask: rune });
    tickRef.current = Math.min(STARTUP_FIRE_TOTAL_TICKS, currentTick + 1);
    setTick(tickRef.current);
  }, [clock, safeHeight, safeWidth]);

  useEffect(() => {
    if (tick < STARTUP_FIRE_TOTAL_TICKS || completedRef.current) return;
    completedRef.current = true;
    fireLog.event('complete', { width: safeWidth, height: safeHeight });
    onComplete();
  }, [onComplete, safeHeight, safeWidth, tick]);

  const frame = composeStartupFireFrame(simulationRef.current, tick, safeHeight, theme);
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
