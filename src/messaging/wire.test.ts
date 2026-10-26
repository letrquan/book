import { describe, expect, it } from 'vitest';
import {
  decodeUdsAddress,
  encodeUdsAddress,
  exceedsLineCap,
  LineReader,
  MAX_LINE_CHARS,
  parseAuthLine,
  parseInboxLine,
  peerTokenMatches,
  serializeFrame,
  type InboxFrame,
} from './wire.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('frames', () => {
  const frames: InboxFrame[] = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: '<cross-session-message from="uds:/s/1.sock">hi</cross-session-message>',
      },
      priority: 'next',
      from: 'uds:/s/1.sock',
      msg_id: 'm-1',
      session_id: 'session-2',
    },
    {
      type: 'control',
      action: 'peer_message_status',
      status: 'dropped',
      orig_msg_id: 'm-1',
      reason: 'dropped at the inbox',
      drop_reason: 'rate-limited',
      dropped_msg_ids: ['m-2', 'm-3'],
      from: 'uds:/s/2.sock',
      msg_id: 'r-1',
    },
    {
      type: 'control',
      action: 'notify_when_idle',
      from: 'uds:/s/1.sock',
      msg_id: 'm-4',
      from_mode: 'prompting',
    },
    {
      type: 'control',
      action: 'peer_idle_notice',
      orig_msg_id: 'm-4',
      state: 'idle',
      finished_at: 1_700_000_000_000,
      detail: 'done',
      from_mode: 'bypass',
    },
  ];

  it.each(frames.map((frame) => [frame.type === 'user' ? 'user' : frame.action, frame] as const))(
    'round-trips a %s frame as one line',
    (_name, frame) => {
      const line = serializeFrame(frame);
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
      expect(parseInboxLine(line.slice(0, -1))).toEqual({ ok: true, frame });
    },
  );

  it('keeps the fields a later version adds', () => {
    const parsed = parseInboxLine(
      JSON.stringify({ type: 'user', message: { content: 'x', extra: 1 }, novel: true }),
    );
    expect(parsed).toMatchObject({ ok: true, frame: { novel: true, message: { extra: 1 } } });
  });

  it('round-trips an auth frame', () => {
    const line = serializeFrame({ type: 'auth', token: TOKEN });
    expect(parseAuthLine(line.trim())).toEqual({ ok: true, frame: { type: 'auth', token: TOKEN } });
  });

  it.each([
    ['', 'not-json'],
    ['   ', 'not-json'],
    ['[1]', 'not-json'],
    ['{"type":"user","message":{"content":"x"}}', 'not-a-frame'],
    ['{"type":"auth"}', 'malformed'],
    ['{"type":"auth","token":7}', 'malformed'],
  ])('refuses %j as a first line (%s)', (line, reason) => {
    expect(parseAuthLine(line)).toEqual({ ok: false, reason });
  });

  it.each([
    ['nope', 'not-json'],
    ['{"no":"type"}', 'not-a-frame'],
    ['{"type":"user","message":{"content":""}}', 'malformed'],
    ['{"type":"user","message":{"content":["block"]}}', 'malformed'],
    ['{"type":"control","action":"rename","name":"x"}', 'unsupported'],
    ['{"type":"control","action":"peer_message_status","status":"lost"}', 'malformed'],
    ['{"type":"telemetry"}', 'unsupported'],
  ])('judges %j after auth as %s', (line, reason) => {
    expect(parseInboxLine(line)).toEqual({ ok: false, reason });
  });
});

describe('peerTokenMatches', () => {
  it('accepts the token', () => {
    expect(peerTokenMatches(TOKEN, TOKEN)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 42],
    ['wrong', 'fedcba9876543210fedcba9876543210'],
    ['too short', TOKEN.slice(0, 31)],
    ['too long', `${TOKEN}0`],
    ['upper case', TOKEN.toUpperCase()],
    // `Buffer.from(…, 'hex')` would stop at the `z` and compare a prefix.
    ['a hex prefix and garbage', `${TOKEN.slice(0, 16)}zzzzzzzzzzzzzzzz`],
  ])('refuses a token that is %s', (_name, given) => {
    expect(peerTokenMatches(given, TOKEN)).toBe(false);
  });
});

describe('LineReader', () => {
  it('splits lines across chunks', () => {
    const reader = new LineReader();
    expect(reader.push('{"a"')).toEqual({ lines: [], overflow: false });
    expect(reader.push(':1}\n{"b":2}\n{"c"')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      overflow: false,
    });
    expect(reader.push(':3}\n')).toEqual({ lines: ['{"c":3}'], overflow: false });
  });

  it('accepts a line exactly at the cap', () => {
    const reader = new LineReader(10);
    expect(reader.push('x'.repeat(10))).toEqual({ lines: [], overflow: false });
    expect(reader.push('\n')).toEqual({ lines: ['x'.repeat(10)], overflow: false });
  });

  it('overflows the moment a line passes the cap, without waiting for its newline', () => {
    const reader = new LineReader(10);
    expect(reader.push('x'.repeat(6)).overflow).toBe(false);
    expect(reader.push('x'.repeat(5)).overflow).toBe(true);
    expect(reader.buffered).toBe(0);
  });

  it('never holds more than the cap however much arrives without a newline', () => {
    const reader = new LineReader();
    const chunk = 'y'.repeat(64 * 1024);
    let overflowed = false;
    for (let i = 0; i < 64 && !overflowed; i++) {
      overflowed = reader.push(chunk).overflow;
      expect(reader.buffered).toBeLessThanOrEqual(MAX_LINE_CHARS);
    }
    expect(overflowed).toBe(true);
  });

  it('holds the first line to a cap of its own, and later lines to the full one', () => {
    const reader = new LineReader(100, 10);
    expect(reader.push('x'.repeat(11)).overflow).toBe(true);
    const next = new LineReader(100, 10);
    expect(next.push(`${'a'.repeat(10)}\n${'b'.repeat(100)}\n`)).toEqual({
      lines: ['a'.repeat(10), 'b'.repeat(100)],
      overflow: false,
    });
  });

  it('overflows on a complete line over the cap', () => {
    expect(new LineReader(4).push('12345\n')).toEqual({ lines: [], overflow: true });
  });
});

describe('exceedsLineCap', () => {
  it('counts characters, not the newline', () => {
    expect(exceedsLineCap(`${'x'.repeat(MAX_LINE_CHARS)}\n`)).toBe(false);
    expect(exceedsLineCap(`${'x'.repeat(MAX_LINE_CHARS + 1)}\n`)).toBe(true);
  });
});

describe('uds addresses', () => {
  it('round-trips a plain socket path unchanged', () => {
    expect(encodeUdsAddress('/run/user/1000/book-socks/42.sock')).toBe(
      'uds:/run/user/1000/book-socks/42.sock',
    );
    expect(decodeUdsAddress('uds:/run/user/1000/book-socks/42.sock')).toBe(
      '/run/user/1000/book-socks/42.sock',
    );
  });

  it('percent-encodes anything outside the safe set', () => {
    const address = encodeUdsAddress('/tmp/a b/é"/42.sock');
    expect(address).toBe('uds:/tmp/a%20b/%C3%A9%22/42.sock');
    expect(decodeUdsAddress(address)).toBe('/tmp/a b/é"/42.sock');
  });

  it.each([
    ['not a string', 7],
    ['another scheme', 'bridge:/x.sock'],
    ['empty', 'uds:'],
    ['a raw space', 'uds:/a b.sock'],
    ['broken percent-encoding', 'uds:/a%zz.sock'],
    ['a NUL', 'uds:/a%00.sock'],
    ['too long', `uds:/${'a'.repeat(200)}`],
  ])('refuses an address that is %s', (_name, address) => {
    expect(decodeUdsAddress(address)).toBeUndefined();
  });
});
