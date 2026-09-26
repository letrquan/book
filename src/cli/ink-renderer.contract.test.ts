import { describe, expect, it } from 'vitest';
import {
  VERIFIED_INK_VERSION,
  hasInkTrailingNewlineFix,
  installedInkVersion,
} from './ink-renderer.js';

describe('Ink renderer contract', () => {
  it('runs the Ink release the TUI was verified against', () => {
    expect(
      installedInkVersion(),
      `Ink changed from the verified ${VERIFIED_INK_VERSION}. Re-verify the TUI as ` +
        'docs/guide/development.md ("Upgrading Ink") describes, then update VERIFIED_INK_VERSION.',
    ).toBe(VERIFIED_INK_VERSION);
  });

  it("has the incremental renderer's trailing-newline fix", () => {
    expect(hasInkTrailingNewlineFix()).toBe(true);
  });
});
