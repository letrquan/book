import xterm from '@xterm/headless';

const { Terminal } = xterm;

/** A terminal resize applied partway through a replay, as SIGWINCH lands between two writes. */
export interface TerminalResize {
  /** The offset into the replayed output at which the terminal takes its new size. */
  at: number;
  cols: number;
  rows: number;
}

export interface TerminalScreenOptions {
  cols?: number;
  rows?: number;
  /** Resizes the terminal once the output before `at` is written; the screen read is the new size. */
  resize?: TerminalResize;
}

/** Replay terminal bytes through xterm.js so assertions inspect the screen, not the write stream. */
export async function replayTerminalOutput(
  output: string,
  { cols = 80, rows = 24, resize }: TerminalScreenOptions = {},
): Promise<string[]> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    if (resize) {
      await write(output.slice(0, resize.at));
      terminal.resize(resize.cols, resize.rows);
      await write(output.slice(resize.at));
    } else {
      await write(output);
    }
    return Array.from({ length: terminal.rows }, (_, index) =>
      (terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').trimEnd(),
    );
  } finally {
    terminal.dispose();
  }
}

export function countScreenOccurrences(lines: readonly string[], value: string): number {
  return lines.reduce((count, line) => count + (line === value ? 1 : 0), 0);
}
