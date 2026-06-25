import { Text } from 'ink';
import { useSpinner } from '../hooks/useAnimation.js';

const GRADIENT_COLORS = ['cyan', 'magenta'];

interface SpinnerProps {
  active?: boolean;
  style?: 'braille' | 'dots';
  color?: string;
}

export function Spinner({ active = true, style = 'braille', color }: SpinnerProps) {
  const { frame } = useSpinner(active, style);
  const spinnerColor = color || GRADIENT_COLORS[0];
  return <Text color={spinnerColor}>{frame} </Text>;
}

export { GRADIENT_COLORS };
