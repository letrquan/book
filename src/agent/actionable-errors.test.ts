import { describe, expect, it } from 'vitest';
import { permissionDeniedError } from './actionable-errors.js';

describe('actionable tool errors', () => {
  it('names the matched rule and safe recovery path', () => {
    const error = permissionDeniedError('Bash', 'Bash(git push *)');
    expect(error).toContain('Bash(git push *)');
    expect(error).toContain('Do not bypass');
    expect(error).toContain('ask the user');
  });
});
