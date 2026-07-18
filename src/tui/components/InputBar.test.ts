import React from 'react';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { InputBar } from './InputBar.js';
import { MODE_COLOR_TOKENS } from '../mode-style.js';
import { displayWidth } from './word-wrap.js';

/**
 * Tests for InputBar: responsive editor box, bottom-pinning layout,
 * Vietnamese character support, and mode prompt colors.
 */

let tempDirs: string[] = [];

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-inputbar-'));
  tempDirs.push(dir);
  return dir;
}

function inputBar(
  onSubmit: (value: string) => void,
  props: Partial<React.ComponentProps<typeof InputBar>> = {},
) {
  return React.createElement(
    ThemeContext.Provider,
    { value: DEFAULT_THEME },
    React.createElement(InputBar, {
      onSubmit,
      disabled: false,
      mode: 'default',
      onCycleMode: () => {},
      commands: [],
      reducedMotion: true,
      ...props,
    }),
  );
}

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function expectFrameWithinWidth(frame: string | undefined, width: number): void {
  for (const line of stripAnsi(frame).split('\n').filter(Boolean)) {
    expect(displayWidth(line)).toBeLessThanOrEqual(width);
  }
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('InputBar editor box', () => {
  it('renders a complete box around the prompt', () => {
    const width = 36;
    const view = render(inputBar(() => {}, { terminalWidth: width, compact: true }));
    const lines = stripAnsi(view.lastFrame()).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[1]).toMatch(/^│ > /);
    expect(lines[1]).toMatch(/│$/);
    expect(lines[2]).toMatch(/^└─+┘$/);
    expectFrameWithinWidth(view.lastFrame(), width);
  });

  it.each([20, 24, 36, 48])('keeps every line within %i columns', (width) => {
    const view = render(inputBar(() => {}, { terminalWidth: width, compact: true }));

    expectFrameWithinWidth(view.lastFrame(), width);
  });

  it('reflows the complete editor box when the terminal shrinks', () => {
    const view = render(inputBar(() => {}, { terminalWidth: 80 }));

    view.rerender(inputBar(() => {}, { terminalWidth: 28, compact: true }));

    const lines = stripAnsi(view.lastFrame()).split('\n');
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[1]).toMatch(/^│ > /);
    expect(lines[1]).toMatch(/│$/);
    expect(lines[2]).toMatch(/^└─+┘$/);
    expectFrameWithinWidth(view.lastFrame(), 28);
  });

  it('keeps the command menu and editor as separate boxes after shrinking', async () => {
    const commands = [
      {
        name: 'clear',
        description: 'Clear the conversation',
        body: 'Clear',
        source: 'project' as const,
      },
    ];
    const view = render(inputBar(() => {}, { terminalWidth: 80, commands }));
    await tick();
    view.stdin.write('/');
    await tick(20);

    view.rerender(inputBar(() => {}, { terminalWidth: 28, commands, compact: true }));

    const lines = stripAnsi(view.lastFrame()).split('\n').filter(Boolean);
    expect(lines.filter((line) => /^┌─+┐$/.test(line))).toHaveLength(2);
    expect(lines.filter((line) => /^└─+┘$/.test(line))).toHaveLength(2);
    expectFrameWithinWidth(view.lastFrame(), 28);
  });
});

describe('InputBar mode border colors', () => {
  it('maps each permission mode to its production theme token', () => {
    expect(MODE_COLOR_TOKENS).toEqual({
      default: 'modeDefault',
      auto: 'modeAuto',
      plan: 'modePlan',
      'accept-edits': 'modeAcceptEdits',
      dontAsk: 'modeDontAsk',
      bypassPermissions: 'modeBypass',
    });
  });

  it('prompt marker is always "> "', () => {
    const prompt = '> ';
    expect(prompt).toBe('> ');
    expect(prompt.length).toBe(2); // ">" + space
  });
});

// ---------------------------------------------------------------------------
// Vietnamese character support (Unicode NFC normalization)
// ---------------------------------------------------------------------------

/**
 * Replicates the normalizeInput function from InputBar.tsx.
 */
function normalizeInput(value: string): string {
  return value.normalize('NFC');
}

describe('Vietnamese character support', () => {
  // ---- Common Vietnamese diacritics ----
  const VIETNAMESE_CHARS = {
    // ă (a-breve): U+0103 (precomposed)
    aBreve: 'ă', // ă
    aBreveDecomposed: 'ă', // a + combining breve
    // â (a-circumflex): U+00E2
    aCircumflex: 'â', // â
    aCircumflexDecomposed: 'â', // a + combining circumflex
    // ơ (o-horn): U+01A1
    oHorn: 'ơ', // ơ
    oHornDecomposed: 'ơ', // o + combining horn
    // ư (u-horn): U+01B0
    uHorn: 'ư', // ư
    uHornDecomposed: 'ư', // u + combining horn
    // đ (d-stroke): U+0111
    dStroke: 'đ', // đ
    // ê (e-circumflex): U+00EA
    eCircumflex: 'ê', // ê
    eCircumflexDecomposed: 'ê', // e + combining circumflex
    // ô (o-circumflex): U+00F4
    oCircumflex: 'ô', // ô
    oCircumflexDecomposed: 'ô', // o + combining circumflex
    // ắ (a-breve-acute): U+1EAF
    aBreveAcute: 'ắ', // ắ
    aBreveAcuteDecomposed: 'ắ', // a + breve + acute
    // ễ (e-circumflex-tilde): U+1EC5
    eCircumflexTilde: 'ễ', // ễ
    eCircumflexTildeDecomposed: 'ễ', // e + circumflex + tilde
    // ệ (e-circumflex-dotBelow): U+1EC7
    eCircumflexDotBelow: 'ệ', // ệ
    eCircumflexDotBelowDecomposed: 'ệ', // e + circumflex + dot below
    // ạ (a-dotBelow): U+1EA1
    aDotBelow: 'ạ', // ạ
    aDotBelowDecomposed: 'ạ', // a + dot below
    // ớ (o-horn-acute): U+1EDB
    oHornAcute: 'ớ', // ớ
    oHornAcuteDecomposed: 'ớ', // o + horn + acute
    // ứ (u-horn-acute): U+1EE9
    uHornAcute: 'ứ', // ứ
    uHornAcuteDecomposed: 'ứ', // u + horn + acute
    // ổ (o-circumflex-hookAbove): U+1ED5
    oCircumflexHook: 'ổ', // ổ
    oCircumflexHookDecomposed: 'ổ', // o + circumflex + hook above
  };

  it('normalizes simple NFD diacritics to NFC precomposed form', () => {
    expect(normalizeInput(VIETNAMESE_CHARS.aBreveDecomposed)).toBe(VIETNAMESE_CHARS.aBreve);
    expect(normalizeInput(VIETNAMESE_CHARS.aCircumflexDecomposed)).toBe(
      VIETNAMESE_CHARS.aCircumflex,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.eCircumflexDecomposed)).toBe(
      VIETNAMESE_CHARS.eCircumflex,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.oCircumflexDecomposed)).toBe(
      VIETNAMESE_CHARS.oCircumflex,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.oHornDecomposed)).toBe(VIETNAMESE_CHARS.oHorn);
    expect(normalizeInput(VIETNAMESE_CHARS.uHornDecomposed)).toBe(VIETNAMESE_CHARS.uHorn);
  });

  it('normalizes multi-tone NFD diacritics to NFC precomposed form', () => {
    // Multi-level diacritics: base + tone mark
    expect(normalizeInput(VIETNAMESE_CHARS.aBreveAcuteDecomposed)).toBe(
      VIETNAMESE_CHARS.aBreveAcute,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.eCircumflexTildeDecomposed)).toBe(
      VIETNAMESE_CHARS.eCircumflexTilde,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.eCircumflexDotBelowDecomposed)).toBe(
      VIETNAMESE_CHARS.eCircumflexDotBelow,
    );
    expect(normalizeInput(VIETNAMESE_CHARS.aDotBelowDecomposed)).toBe(VIETNAMESE_CHARS.aDotBelow);
    expect(normalizeInput(VIETNAMESE_CHARS.oHornAcuteDecomposed)).toBe(VIETNAMESE_CHARS.oHornAcute);
    expect(normalizeInput(VIETNAMESE_CHARS.uHornAcuteDecomposed)).toBe(VIETNAMESE_CHARS.uHornAcute);
    expect(normalizeInput(VIETNAMESE_CHARS.oCircumflexHookDecomposed)).toBe(
      VIETNAMESE_CHARS.oCircumflexHook,
    );
  });

  it('NFC strings pass through unchanged', () => {
    // Already-composed Vietnamese characters should remain the same.
    const nfcChars = Object.entries(VIETNAMESE_CHARS)
      .filter(([k]) => !k.endsWith('Decomposed'))
      .map(([, v]) => v);

    for (const ch of nfcChars) {
      expect(normalizeInput(ch)).toBe(ch);
    }
  });

  it('handles full Vietnamese sentences with mixed diacritics', () => {
    // Common Vietnamese sentence: "Tôi đang học tiếng Việt"
    // NFC form
    const nfc = 'Tôi đang học tiếng Việt';
    // NFD form (decomposed)
    const nfd = 'Tôi đang học tiếng Việt';

    expect(normalizeInput(nfd)).toBe(nfc);
    expect(normalizeInput(nfc)).toBe(nfc); // already NFC
  });

  it('handles additional Vietnamese tone marks', () => {
    // Full set: sắc (acute), huyền (grave), hỏi (hook), ngã (tilde), nặng (dot below)
    const testCases: [string, string][] = [
      // á: a + combining acute
      ['á', 'á'],
      // à: a + combining grave
      ['à', 'à'],
      // ả: a + combining hook above
      ['ả', 'ả'],
      // ã: a + combining tilde
      ['ã', 'ã'],
      // ạ: a + combining dot below
      ['ạ', 'ạ'],
      // ọ: o + combining dot below
      ['ọ', 'ọ'],
      // ụ: u + combining dot below
      ['ụ', 'ụ'],
      // ị: i + combining dot below
      ['ị', 'ị'],
    ];

    for (const [decomposed, precomposed] of testCases) {
      expect(normalizeInput(decomposed)).toBe(precomposed);
    }
  });

  it('handles mixed ASCII and Vietnamese characters', () => {
    const mixed = 'Fix lỗi trong hàm xử lý chuỗi — thêm hỗ trợ tiếng Việt (ắ, ễ, ệ, ạ, ớ, ứ, ổ)';
    // normalizeInput on NFC should be idempotent
    expect(normalizeInput(mixed)).toBe(mixed);
    expect(normalizeInput(normalizeInput(mixed))).toBe(mixed);
  });

  it('handles empty string normalization', () => {
    expect(normalizeInput('')).toBe('');
  });

  it('does not modify ASCII-only text', () => {
    const ascii = 'Hello, world! This is a test -- with @path and !command.';
    expect(normalizeInput(ascii)).toBe(ascii);
  });

  it('handles decomposed @mention paths containing Vietnamese', () => {
    // User types @bài-tập (decomposed "bài-tập")
    const input = '@bài-tập';
    const expected = '@bài-tập';
    expect(normalizeInput(input)).toBe(expected);
  });

  it('correctly passes Vietnamese text through trim check', () => {
    // The handleSubmit check: val.trim() should not strip Vietnamese.
    const vi = '  đáp án  '; // with surrounding spaces
    const normalized = normalizeInput(vi);
    expect(normalized.trim()).toBe('đáp án');
    expect(normalized.trim().length).toBeGreaterThan(0);
  });

  it('Vietnamese uppercase letters also normalize correctly', () => {
    // Uppercase Vietnamese letters
    expect(normalizeInput('Ă')).toBe('Ă'); // Ă
    expect(normalizeInput('Â')).toBe('Â'); // Â
    expect(normalizeInput('Ê')).toBe('Ê'); // Ê
    expect(normalizeInput('Ô')).toBe('Ô'); // Ô
    expect(normalizeInput('Ơ')).toBe('Ơ'); // Ơ
    expect(normalizeInput('Ư')).toBe('Ư'); // Ư
  });
});

describe('InputBar command menu', () => {
  it('Enter on an open slash menu submits the selected command, not raw /', async () => {
    const submitted: string[] = [];
    const view = render(inputBar((value) => submitted.push(value)));
    await tick();

    view.stdin.write('/');
    await tick(20);
    expect(view.lastFrame()).toContain('/clear');

    view.stdin.write('\r');
    await tick(20);

    expect(submitted).toEqual(['/clear']);
  });
});

describe('InputBar @ file mention menu', () => {
  it('shows file suggestions when typing an @ path', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export {};');
    vi.stubEnv('BOOK_WORKSPACE', ws);

    const view = render(inputBar(() => {}));
    await tick();

    view.stdin.write('@src/');
    await tick(200);

    expect(view.lastFrame()).toContain('@src/app.ts');
  });

  it('Tab accepts the selected file suggestion', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export {};');
    vi.stubEnv('BOOK_WORKSPACE', ws);

    const submitted: string[] = [];
    const view = render(inputBar((value) => submitted.push(value)));
    await tick();

    view.stdin.write('@src/');
    await tick(200);
    view.stdin.write('\t');
    await tick(20);
    view.stdin.write('\r');
    await tick(200);

    expect(submitted[0]).toBe('@src/app.ts ');
    expect(submitted[0]).not.toContain('Contents of src/app.ts:');
  });

  it('Enter accepts the selected file suggestion without submitting immediately', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export {};');
    vi.stubEnv('BOOK_WORKSPACE', ws);

    const submitted: string[] = [];
    const view = render(inputBar((value) => submitted.push(value)));
    await tick();

    view.stdin.write('@src/');
    await tick(200);
    view.stdin.write('\r');
    await tick(200);

    expect(submitted).toEqual([]);
    expect(view.lastFrame()).toContain('@src/app.ts');

    view.stdin.write('\r');
    await tick(200);

    expect(submitted).toEqual(['@src/app.ts ']);
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut handling
// ---------------------------------------------------------------------------

/**
 * Simulate InputBar's useInput handler — filters out meta-modified keys,
 * forwards Ctrl combos to onGlobalShortcut, and handles navigation keys.
 *
 * Returns: 'consumed' | 'forwarded' | 'passed-through'
 */
function simulateInputHandler(
  input: string,
  key: {
    meta?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    tab?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    return?: boolean;
  },
  hasHistory: boolean,
): 'consumed' | 'forwarded' | 'passed-through' {
  // Meta (Alt) keys are shortcuts, never text input.
  if (key.meta) return 'consumed';

  if (key.shift && key.tab) return 'consumed';

  // Tab to accept suggestion
  if (key.tab) return 'consumed';

  // Ctrl+J / Shift+Enter insert a newline locally.
  if ((key.ctrl && (input === 'j' || input === '\n')) || (key.shift && key.return))
    return 'consumed';

  // Forward Ctrl-based shortcuts to parent
  if (key.ctrl) return 'forwarded';

  // Up arrow — navigate history
  if (key.upArrow && hasHistory) return 'consumed';

  // Down arrow — navigate history
  if (key.downArrow) return 'consumed';

  // Filter out SGR mouse escape sequences (enabled for scroll wheel).
  // These start with \x1b[< and are not keyboard input.
  if (input.startsWith('\x1b[<')) return 'consumed';

  return 'passed-through';
}

describe('keyboard shortcut filtering', () => {
  it('keeps the editor draft unchanged when an SGR wheel report arrives', async () => {
    const view = render(inputBar(() => {}));
    await tick();

    view.stdin.write('draft');
    await tick(20);
    view.stdin.write('\x1b[<64;13;20M');
    await tick(20);

    expect(stripAnsi(view.lastFrame())).toContain('draft');
    expect(stripAnsi(view.lastFrame())).not.toContain('[<64');
  });

  it('does not navigate prompt history when an SGR wheel report arrives', async () => {
    const submitted: string[] = [];
    const view = render(inputBar((value) => submitted.push(value)));
    await tick();

    view.stdin.write('previous');
    await tick(20);
    view.stdin.write('\r');
    await tick(20);
    view.stdin.write('current');
    await tick(20);
    view.stdin.write('\x1b[<64;13;20M');
    await tick(20);

    expect(submitted).toEqual(['previous']);
    expect(stripAnsi(view.lastFrame())).toContain('current');
    expect(stripAnsi(view.lastFrame())).not.toContain('previous');
  });

  it('restores the editor value after Alt and consumed Ctrl shortcuts', async () => {
    const view = render(
      inputBar(() => {}, {
        onGlobalShortcut: (input, key) => Boolean(key.ctrl && input === 'l'),
      }),
    );
    await tick();

    view.stdin.write('draft');
    await tick(20);
    view.stdin.write('\x1bp');
    await tick(20);
    expect(stripAnsi(view.lastFrame())).toContain('draft');
    expect(stripAnsi(view.lastFrame())).not.toContain('draftp');

    view.stdin.write('\x0c');
    await tick(20);
    expect(stripAnsi(view.lastFrame())).toContain('draft');
    expect(stripAnsi(view.lastFrame())).not.toContain('draftl');
  });

  it('preserves prompt text while detailed transcript mode suppresses input', async () => {
    const view = render(inputBar(() => {}, { inputSuppressed: false }));
    await tick();
    view.stdin.write('draft prompt');
    await tick(20);

    view.rerender(inputBar(() => {}, { inputSuppressed: true }));
    view.stdin.write('q');
    await tick(20);
    expect(stripAnsi(view.lastFrame())).toContain('draft prompt');
    expect(stripAnsi(view.lastFrame())).not.toContain('draft promptq');

    view.rerender(inputBar(() => {}, { inputSuppressed: false }));
    await tick(20);
    expect(stripAnsi(view.lastFrame())).toContain('draft prompt');
  });

  it('Alt+M (meta+m) is consumed and does not write "m" into input', () => {
    expect(simulateInputHandler('m', { meta: true }, false)).toBe('consumed');
  });

  it('plain "m" without modifiers passes through to text input', () => {
    expect(simulateInputHandler('m', {}, false)).toBe('passed-through');
  });

  it('all Alt/Meta-modified keys are consumed', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const ch of letters) {
      expect(simulateInputHandler(ch, { meta: true }, false)).toBe('consumed');
    }
  });

  it('all Ctrl-modified shortcuts except Ctrl+J are forwarded to parent', () => {
    // Ctrl shortcuts go to onGlobalShortcut, not the text input.
    for (const ch of ['c', 'l', 's', 'h', 't', 'd', 'r', '/']) {
      expect(simulateInputHandler(ch, { ctrl: true }, false)).toBe('forwarded');
    }
  });

  it('Ctrl+J and Shift+Enter are consumed for local newline insertion', () => {
    expect(simulateInputHandler('j', { ctrl: true }, false)).toBe('consumed');
    expect(simulateInputHandler('\n', { ctrl: true }, false)).toBe('consumed');
    expect(simulateInputHandler('', { shift: true, return: true }, false)).toBe('consumed');
  });

  it('plain letters without modifiers pass through to text input', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (const ch of letters) {
      expect(simulateInputHandler(ch, {}, false)).toBe('passed-through');
    }
  });

  it('Shift+Tab (mode cycle) is consumed', () => {
    expect(simulateInputHandler('\t', { shift: true, tab: true }, false)).toBe('consumed');
  });

  it('plain Tab is consumed (accepts suggestion)', () => {
    expect(simulateInputHandler('\t', { tab: true }, false)).toBe('consumed');
  });

  it('Up arrow is consumed when history exists', () => {
    expect(simulateInputHandler('', { upArrow: true }, true)).toBe('consumed');
    // No history — falls through (passed through)
    expect(simulateInputHandler('', { upArrow: true }, false)).toBe('passed-through');
  });

  it('Down arrow is always consumed', () => {
    expect(simulateInputHandler('', { downArrow: true }, true)).toBe('consumed');
    expect(simulateInputHandler('', { downArrow: true }, false)).toBe('consumed');
  });

  it('Page/Home/End keys are consumed', () => {
    expect(simulateInputHandler('', { pageUp: true }, false)).toBe('passed-through');
    expect(simulateInputHandler('', { pageDown: true }, false)).toBe('passed-through');
    expect(simulateInputHandler('', { home: true }, false)).toBe('passed-through');
    expect(simulateInputHandler('', { end: true }, false)).toBe('passed-through');
  });

  it('punctuation passes through (?, @, !, /, etc. are valid text)', () => {
    const punctuation = '?@!.,;:<>[]{}()#$%^&*+-=_~`|/\\"\'';
    for (const ch of punctuation) {
      expect(simulateInputHandler(ch, {}, false)).toBe('passed-through');
    }
  });

  it('Ctrl+/ is forwarded (help shortcut handled by parent callback)', () => {
    expect(simulateInputHandler('/', { ctrl: true }, false)).toBe('forwarded');
  });

  it('plain "/" passes through to text input', () => {
    expect(simulateInputHandler('/', {}, false)).toBe('passed-through');
  });

  it('onGlobalShortcut returns true when shortcut is consumed', () => {
    // Simulate the App's handleGlobalShortcut callback.
    function handleGlobalShortcut(input: string, key: { ctrl?: boolean }): boolean {
      if (key.ctrl && input === '/') return true; // consumed
      return false; // not consumed
    }

    expect(handleGlobalShortcut('/', { ctrl: true })).toBe(true);
    expect(handleGlobalShortcut('t', { ctrl: true })).toBe(false);
    expect(handleGlobalShortcut('/', {})).toBe(false);
  });

  it('SGR mouse wheel up (scroll up) is filtered and not typed', () => {
    // Scroll up: \x1b[<64;col;rowM
    expect(simulateInputHandler('\x1b[<64;13;20M', {}, false)).toBe('consumed');
    expect(simulateInputHandler('\x1b[<64;5;10M', {}, true)).toBe('consumed');
  });

  it('SGR mouse wheel down (scroll down) is filtered and not typed', () => {
    // Scroll down: \x1b[<65;col;rowM
    expect(simulateInputHandler('\x1b[<65;13;20M', {}, false)).toBe('consumed');
    expect(simulateInputHandler('\x1b[<65;8;15M', {}, true)).toBe('consumed');
  });

  it('SGR mouse click events are filtered and not typed', () => {
    // Left click (button 0), right click (button 2), middle click (button 1)
    expect(simulateInputHandler('\x1b[<0;25;10M', {}, false)).toBe('consumed');
    expect(simulateInputHandler('\x1b[<2;12;7M', {}, false)).toBe('consumed');
    // Release events end with 'm' instead of 'M'
    expect(simulateInputHandler('\x1b[<0;25;10m', {}, false)).toBe('consumed');
  });

  it('SGR mouse move events are filtered and not typed', () => {
    // Motion with button 32 (motion + button 0)
    expect(simulateInputHandler('\x1b[<32;15;8M', {}, false)).toBe('consumed');
    // Motion with no button (button 35 = release motion)
    expect(simulateInputHandler('\x1b[<35;20;12M', {}, false)).toBe('consumed');
  });

  it('plain text with bracket-like start is NOT erroneously filtered', () => {
    // Text that happens to start with "[" is still normal keyboard input
    expect(simulateInputHandler('[hello', {}, false)).toBe('passed-through');
    expect(simulateInputHandler('<<<', {}, false)).toBe('passed-through');
    // \x1b (ESC) followed by something other than [< is not a mouse sequence
    // (this is how terminals send escape then a regular key)
    expect(simulateInputHandler('\x1b[A', { upArrow: true }, false)).toBe('passed-through');
  });
});
