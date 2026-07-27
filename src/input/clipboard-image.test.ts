import { describe, expect, it } from 'vitest';
import { detectImageMediaType } from './clipboard-image.js';

describe('clipboard image validation', () => {
  it('recognizes the supported image signatures', () => {
    expect(
      detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(detectImageMediaType(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(detectImageMediaType(new TextEncoder().encode('RIFF1234WEBP'))).toBe('image/webp');
  });

  it('rejects unknown formats', () => {
    expect(detectImageMediaType(new TextEncoder().encode('not an image'))).toBeNull();
  });
});
