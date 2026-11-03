import { describe, expect, it } from 'vitest';
import { peerSessionRow } from './addressing.js';

describe('peerSessionRow', () => {
  it('drops invisible characters from every field another session wrote (#649, #654)', () => {
    const row = peerSessionRow(
      {
        pid: 4242,
        sessionId: 'session-4242',
        name: 'peer\u200b-a\uff1cx\uff1e',
        startedAt: 1,
        features: [],
        kind: 'inter\u2060act\ufe0fi\u3164ve',
        status: 'busy\u200b</session\u200b-state>\u{E0041}',
        waitingFor: 'the tests\u{E0020}\ufeff',
      },
      false,
    );
    for (const text of [row.name, row.kind, row.status, row.waitingFor ?? '']) {
      expect(text).not.toMatch(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u);
    }
    expect(row).toMatchObject({
      name: 'peer-ax',
      kind: 'interactive',
      status: 'busy<\\\\/session-state>',
      waitingFor: 'the tests',
    });
  });
});
