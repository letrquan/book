import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { enterIsolatedHome, isolateBookHome, leaveIsolatedHome } from './isolated-book-home.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
// This file's own fixture strings spell out every pattern the predicates look for.
const GUARD_FILE = basename(fileURLToPath(import.meta.url));

/**
 * True when the source can reach the print-mode runner, which writes a record of every run
 * under BOOK_HOME (#421): a static or dynamic import of an `sdk.js` at any depth, or a call to
 * `runHeadless(` or `runMainAction(`.
 */
function drivesRunner(source: string): boolean {
  return (
    /\bfrom\s+['"][^'"]*\/sdk\.js['"]/.test(source) ||
    /\bimport\(\s*['"][^'"]*\/sdk\.js['"]\s*\)/.test(source) ||
    /\brunHeadless\(/.test(source) ||
    /\brunMainAction\(/.test(source)
  );
}

/** The source without its line and block comments (a URL's `//` is not a comment). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * True when the whole file runs under a pinned BOOK_HOME: an `isolateBookHome(` call at the top
 * level of the file (a call scoped to one `describe` leaves the others unpinned), or a real
 * `process.env.BOOK_HOME =` assignment, or the same through `vi.stubEnv('BOOK_HOME', …)` or the
 * `stashEnv('BOOK_HOME', …)` helper the `cli/run*` suites each define for it. A mention in a
 * comment is not a pin.
 */
function pinsHome(source: string): boolean {
  const code = withoutComments(source);
  return (
    /^(?:(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*)?isolateBookHome\(/m.test(code) ||
    /\bprocess\.env\.BOOK_HOME\s*=(?!=)/.test(code) ||
    /\b(?:vi\.stubEnv|stashEnv)\(\s*['"]BOOK_HOME['"]/.test(code)
  );
}

describe('drivesRunner', () => {
  it.each([
    "import { query } from './sdk.js';",
    "import { query } from '../sdk.js';",
    'import { query } from "../../sdk.js";',
    "import {\n  query,\n} from '../../../src/sdk.js';",
    "const { query } = await import('./sdk.js');",
    "const sdk = import('../sdk.js');",
    'const { query } = await import("../../sdk.js");',
    'await runHeadless(config, options);',
    'await runMainAction({ print: "hi" });',
  ])('matches %s', (source) => {
    expect(drivesRunner(source)).toBe(true);
  });

  it.each([
    "import { runHeadless } from './headless.js';",
    "import { createSdkTools } from './sdk-tools.js';",
    "import { query } from './not-sdk.js.map';",
    'const runMainActionOptions = {};',
  ])('does not match %s', (source) => {
    expect(drivesRunner(source)).toBe(false);
  });
});

describe('pinsHome', () => {
  it.each([
    "isolateBookHome('x-');",
    "const bookHome = isolateBookHome('x-');",
    "import { isolateBookHome } from './isolated-book-home.js';\n\nisolateBookHome();\n",
    'beforeEach(() => {\n  process.env.BOOK_HOME = home;\n});',
    'process.env.BOOK_HOME=home;',
    "vi.stubEnv('BOOK_HOME', home);",
    "stashEnv('BOOK_HOME', home);",
    "const u = 'https://x.test'; process.env.BOOK_HOME = home;",
  ])('accepts %s', (source) => {
    expect(pinsHome(source)).toBe(true);
  });

  it.each([
    '// BOOK_HOME is not pinned here',
    '/* process.env.BOOK_HOME = home; */',
    '// process.env.BOOK_HOME = home;',
    "// isolateBookHome('x-');",
    "describe('suite', () => {\n  const home = isolateBookHome('x-');\n});",
    "import { isolateBookHome } from './isolated-book-home.js';",
    "expect(process.env.BOOK_HOME).toBe('x');",
    'if (process.env.BOOK_HOME === undefined) return;',
    "vi.stubEnv('BOOK_API_KEY', 'k');",
    "// stashEnv('BOOK_HOME', home);",
    "const u = 'https://x.test'; // process.env.BOOK_HOME = home;",
  ])('rejects %s', (source) => {
    expect(pinsHome(source)).toBe(false);
  });
});

// A suite that drives the print-mode runner (directly, or through the SDK) without a
// pinned home writes each run's record into the developer's real ~/.book/runs (#421).
describe('the suites', () => {
  it('pin BOOK_HOME in every suite that drives the print-mode runner', () => {
    const unpinned = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.test\.tsx?$/.test(file) && basename(file) !== GUARD_FILE)
      .filter((file) => {
        const source = readFileSync(join(SRC, file), 'utf8');
        return drivesRunner(source) && !pinsHome(source);
      })
      .sort();
    expect(unpinned).toEqual([]);
  });
});

describe('enterIsolatedHome / leaveIsolatedHome', () => {
  const original = process.env.BOOK_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.BOOK_HOME;
    else process.env.BOOK_HOME = original;
  });

  it('points BOOK_HOME at a new empty directory', () => {
    process.env.BOOK_HOME = 'previous-home';
    const handle = enterIsolatedHome('book-isolated-home-test-');
    try {
      expect(process.env.BOOK_HOME).toBe(handle.home);
      expect(handle.home).not.toBe('previous-home');
      expect(basename(handle.home)).toMatch(/^book-isolated-home-test-/);
      expect(readdirSync(handle.home)).toEqual([]);
    } finally {
      leaveIsolatedHome(handle);
    }
  });

  it('puts a previous BOOK_HOME back', () => {
    process.env.BOOK_HOME = 'previous-home';
    const handle = enterIsolatedHome();
    leaveIsolatedHome(handle);
    expect(process.env.BOOK_HOME).toBe('previous-home');
  });

  it('deletes BOOK_HOME again when it was unset before', () => {
    delete process.env.BOOK_HOME;
    const handle = enterIsolatedHome();
    expect(process.env.BOOK_HOME).toBe(handle.home);
    leaveIsolatedHome(handle);
    expect('BOOK_HOME' in process.env).toBe(false);
  });

  it('removes the temporary directory with what the test wrote into it', () => {
    const handle = enterIsolatedHome();
    writeFileSync(join(handle.home, 'runs.json'), '{}');
    leaveIsolatedHome(handle);
    expect(existsSync(handle.home)).toBe(false);
  });

  it('captures the previous value when it enters, not when the suite is declared', () => {
    process.env.BOOK_HOME = 'first';
    const first = enterIsolatedHome();
    leaveIsolatedHome(first);
    process.env.BOOK_HOME = 'second';
    const second = enterIsolatedHome();
    leaveIsolatedHome(second);
    expect(process.env.BOOK_HOME).toBe('second');
  });
});

describe('isolateBookHome', () => {
  const bookHome = isolateBookHome('book-isolated-home-hook-');

  it('gives each test its own directory under BOOK_HOME', () => {
    const home = bookHome();
    expect(process.env.BOOK_HOME).toBe(home);
    expect(existsSync(home)).toBe(true);
    writeFileSync(join(home, 'marker'), 'x');
  });

  it('does not carry one test directory into the next', () => {
    expect(readdirSync(bookHome())).toEqual([]);
  });
});
