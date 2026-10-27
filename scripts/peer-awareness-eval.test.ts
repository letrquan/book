import { describe, expect, it } from 'vitest';
import { runPeerAwarenessEval } from './peer-awareness-eval.js';

describe.skipIf(process.platform === 'win32')('peer awareness eval, mock mode (#620 PR 4)', () => {
  it('loses the peer edit without peer awareness, and keeps it with it', async () => {
    const [off, on] = await runPeerAwarenessEval();

    expect(off).toMatchObject({
      arm: 'off',
      lostEdits: 1,
      conflictsNoticed: 0,
      coordination: 0,
      overlapWarnings: 0,
      peerChars: 0,
    });
    expect(on).toMatchObject({
      arm: 'on',
      lostEdits: 0,
      conflictsNoticed: 1,
      coordination: 1,
      overlapWarnings: 2,
    });
    expect(on!.peerChars).toBeGreaterThan(0);
  }, 60_000);
});
