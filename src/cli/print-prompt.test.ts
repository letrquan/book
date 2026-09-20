import { describe, expect, it } from 'vitest';
import { resolvePrintPrompt } from './utils.js';

describe('resolvePrintPrompt', () => {
  it('takes a positional prompt when --print has no value of its own (#226)', () => {
    // `book --print --model m "Continue"`: commander gave `--print` no value
    // because the next token was a flag, and rejected "Continue" as a stray
    // positional. The positional is the prompt.
    expect(resolvePrintPrompt(true, 'Continue the task')).toEqual({
      print: 'Continue the task',
    });
  });

  it('leaves the flag value alone when there is no positional', () => {
    expect(resolvePrintPrompt('explain', undefined)).toEqual({ print: 'explain' });
    // Bare `-p` still means "read the prompt from stdin".
    expect(resolvePrintPrompt(true, undefined)).toEqual({ print: true });
    expect(resolvePrintPrompt(undefined, undefined)).toEqual({ print: undefined });
  });

  it('refuses a prompt given both as the flag value and as the argument', () => {
    // `book -p "a" "b"` has no right answer; picking one silently would run
    // the wrong prompt.
    expect(resolvePrintPrompt('a', 'b')).toEqual({
      error: expect.stringMatching(/given twice.*--print 'a'.*argument 'b'/),
    });
  });

  it('refuses a positional prompt without --print', () => {
    // The TUI has no initial-prompt input, and a mistyped subcommand such as
    // `book doctr` lands here too (the root has an action handler, so commander
    // never took its "unknown command" path), so the message points both
    // readers somewhere useful.
    const result = resolvePrintPrompt(undefined, 'doctr');
    expect(result).toEqual({ error: expect.stringMatching(/argument 'doctr'/) });
    expect((result as { error: string }).error).toMatch(/-p\/--print/);
    expect((result as { error: string }).error).toMatch(/book --help/);
  });
});
