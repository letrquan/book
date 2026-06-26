import { Text } from 'ink';
import { useGradientSpinner } from '../hooks/useAnimation.js';

interface SpinnerProps {
  active?: boolean;
  style?: 'braille' | 'dots';
  color?: string;
  reducedMotion?: boolean;
}

export function Spinner({ active = true, style = 'braille', color, reducedMotion = false }: SpinnerProps) {
  const { frame, color: gradientColor } = useGradientSpinner(active, style, reducedMotion);
  const spinnerColor = color || gradientColor;
  return <Text color={spinnerColor}>{frame} </Text>;
}
