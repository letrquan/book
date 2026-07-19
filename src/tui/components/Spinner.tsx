import { Text, Box } from 'ink';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useGradientSpinner } from '../hooks/useAnimation.js';
import { useTheme } from '../theme.js';

export const SPINNER_TIPS = [
  'Press Ctrl+/ for keyboard shortcuts',
  'Use @filename to include file contents',
  'Start with ! to run a shell command',
  'Press Esc or Ctrl+C to cancel the current operation',
  'Type /help for available commands',
  'Alt+M to cycle permission modes',
  'Alt+P to open the model picker',
  'Use /compact when context is getting long',
  'Use /theme to choose and save a color theme',
  'Ctrl+T to toggle the task list',
  'Sessions auto-save — use -c to resume',
  'Ctrl+J or Shift+Enter for multiline input',
  'Type /task <subject> to add a task',
  'The model can use multiple tools per turn',
  'Use /new to start fresh; /resume returns to saved conversations',
  'Use PageUp/PageDown to review earlier messages',
  'Tab to accept suggestions in the input bar',
  'Up/Down arrows for input history',
  'Ctrl+L to redraw the screen',
];

interface SpinnerProps {
  active?: boolean;
  style?: 'braille' | 'dots';
  color?: string;
  reducedMotion?: boolean;
  showTips?: boolean;
  /** Custom tip strings to override the defaults. */
  tips?: string[];
  /** If true, only show custom tips (no defaults mixed in). */
  excludeDefaultTips?: boolean;
}

/**
 * Claude Code-style spinner with rotating tips.
 *
 * During long operations, the spinner cycles through a list of tips every 4
 * seconds, shown inline next to the spinner frame. The tip list is
 * configurable via the `tips` and `excludeDefaultTips` props.
 */
export function Spinner({
  active = true,
  style = 'braille',
  color,
  reducedMotion = false,
  showTips = false,
  tips,
  excludeDefaultTips = false,
}: SpinnerProps) {
  const theme = useTheme();
  const { frame, color: gradientColor } = useGradientSpinner(active, style, reducedMotion);
  const spinnerColor = color || gradientColor;
  const [tipIndex, setTipIndex] = useState(0);
  const tipTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveTips = useMemo(() => {
    if (tips && excludeDefaultTips) return tips;
    if (tips) return [...SPINNER_TIPS, ...tips];
    return SPINNER_TIPS;
  }, [tips, excludeDefaultTips]);

  useEffect(() => {
    if (!active || !showTips) {
      if (tipTimerRef.current) {
        clearInterval(tipTimerRef.current);
        tipTimerRef.current = null;
      }
      return;
    }
    // Reset tip index when starting.
    setTipIndex(0);
    tipTimerRef.current = setInterval(() => {
      setTipIndex((i) => (i + 1) % effectiveTips.length);
    }, 4000);
    return () => {
      if (tipTimerRef.current) {
        clearInterval(tipTimerRef.current);
        tipTimerRef.current = null;
      }
    };
  }, [active, showTips, effectiveTips.length]);

  const tip = effectiveTips[tipIndex];

  return (
    <Box>
      <Text color={spinnerColor}>{frame} </Text>
      {showTips && active && tip ? (
        <Text color={theme.subtle} dimColor>
          {tip}
        </Text>
      ) : null}
    </Box>
  );
}
