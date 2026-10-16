import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const homes = vi.hoisted(() => ({ resolve: vi.fn<() => string>() }));
vi.mock('../book-home.js', () => ({ resolveBookHome: homes.resolve }));

import { boundToolResultOutput, TOOL_RESULT_MAX_BYTES, toolSuccess } from './result.js';

let home: string | undefined;
afterEach(() => {
  homes.resolve.mockReset();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('boundToolResultOutput resolves the spill directory only when it spills', () => {
  it('does not read the home for a result that fits', async () => {
    homes.resolve.mockImplementation(() => {
      throw new Error('the home was resolved for a result that was not clipped');
    });

    await boundToolResultOutput(toolSuccess('small'), process.cwd());

    expect(homes.resolve).not.toHaveBeenCalled();
  });

  it('reads the home once for a result it clips, and writes under it', async () => {
    home = mkdtempSync(join(tmpdir(), 'book-lazy-home-'));
    homes.resolve.mockReturnValue(home);

    await boundToolResultOutput(
      toolSuccess('z'.repeat(TOOL_RESULT_MAX_BYTES + 100)),
      process.cwd(),
    );

    expect(homes.resolve).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(home, 'tool-output'))).toHaveLength(1);
  });

  it('does not read the home when the caller names the directory', async () => {
    home = mkdtempSync(join(tmpdir(), 'book-lazy-home-'));
    homes.resolve.mockImplementation(() => {
      throw new Error('the home was resolved although a directory was given');
    });

    await boundToolResultOutput(
      toolSuccess('z'.repeat(TOOL_RESULT_MAX_BYTES + 100)),
      process.cwd(),
      undefined,
      home,
    );

    expect(readdirSync(home)).toHaveLength(1);
  });
});
