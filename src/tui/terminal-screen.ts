import xterm from '@xterm/headless';

const { Terminal } = xterm;

export interface TerminalScreenOptions {
  cols?: number;
  rows?: number;
}

/** Replay terminal bytes through xterm.js so assertions inspect the screen, not the write stream. */
export async function replayTerminalOutput(
  output: string,
  { cols = 80, rows = 24 }: TerminalScreenOptions = {},
): Promise<string[]> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  try {
    await new Promise<void>((resolve) => terminal.write(output, resolve));
    return Array.from({ length: rows }, (_, index) =>
      (terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').trimEnd(),
    );
  } finally {
    terminal.dispose();
  }
}

export function countScreenOccurrences(lines: readonly string[], value: string): number {
  return lines.reduce((count, line) => count + (line === value ? 1 : 0), 0);
}
