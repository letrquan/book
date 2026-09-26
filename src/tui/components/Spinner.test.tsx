import { afterEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { cleanup, render } from 'ink-testing-library';
import { SPINNER_TIPS, SpinnerGlyphs } from './Spinner.js';

afterEach(() => cleanup());

describe('Spinner tips', () => {
  it('advertises supported transcript scrolling keys', () => {
    const tips = SPINNER_TIPS.join('\n');
    expect(tips).toContain('PageUp/PageDown');
    expect(tips).not.toContain('terminal scrollback');
  });
});

describe('SpinnerGlyphs', () => {
  const truecolor = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    return `38;2;${r};${g};${b}m`;
  };
  const renderRaw = (element: React.ReactElement) => {
    const level = chalk.level;
    chalk.level = 3;
    try {
      return render(element).lastFrame() ?? '';
    } finally {
      chalk.level = level;
    }
  };

  it('paints each cell in its own colour', () => {
    const raw = renderRaw(<SpinnerGlyphs frame="⠁⠂" colors={['#e4573d', '#6f6a61']} />);
    expect(raw).toContain(`${truecolor('#e4573d')}⠁`);
    expect(raw).toContain(`${truecolor('#6f6a61')}⠂`);
  });

  it('paints every cell one colour when a caller asks for one', () => {
    const raw = renderRaw(
      <SpinnerGlyphs frame="⠁⠂" colors={['#e4573d', '#6f6a61']} color="#ff9f0a" />,
    );
    expect(raw).toContain(`${truecolor('#ff9f0a')}⠁⠂`);
  });
});
