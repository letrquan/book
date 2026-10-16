import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { unpinnedDriveLines } from './book-home-guard.js';
import { enterIsolatedHome, isolateBookHome, leaveIsolatedHome } from './isolated-book-home.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Fixture sources are parsed, never run, so this file's own strings cannot flag it. */
const unpinned = (source: string): number[] => unpinnedDriveLines(source);

describe('what drives the print-mode runner', () => {
  it.each([
    ['a runHeadless call', 'await runHeadless(config, options);'],
    ['a runMainAction call', 'await runMainAction({ print: "hi" });'],
    ['a member call of either', 'await cli.runMainAction(options);'],
    ['a call of a name imported from ./sdk.js', "import { query } from './sdk.js';\nquery(a);"],
    ['a call of a name imported from ../sdk.js', "import { query } from '../sdk.js';\nquery(a);"],
    [
      'a call of a name imported from a deep sdk.js',
      'import {\n  query as ask,\n} from "../../../src/sdk.js";\nask(a);',
    ],
    ['a call of a default import from sdk.js', "import q from './sdk.js';\nq();"],
    ['a member call of a namespace import', "import * as sdk from './sdk.js';\nsdk.query(a);"],
    ['an awaited dynamic import', "const { query } = await import('./sdk.js');"],
    ['a bare dynamic import', "const sdk = import('../sdk.js');"],
    ['a dynamic import in double quotes', 'await import("../../sdk.js");'],
  ])('flags %s', (_name, source) => {
    expect(unpinned(source)).not.toEqual([]);
  });

  it.each([
    [
      'a type-only import from sdk.js',
      "import type { Options } from './sdk.js';\nconst o: Options = {};",
    ],
    ['an import of sdk.js that is never called', "import { query } from './sdk.js';\nvoid 0;"],
    ['a runner imported but not called', "import { runHeadless } from './headless.js';"],
    ['a name that only resembles the runner', 'const runMainActionOptions = {};'],
    ['a similarly named module', "import { query } from './sdk-tools.js';\nquery(a);"],
    ['a call in a line comment', '// await runHeadless(config);'],
    ['a call in a block comment', '/* await runMainAction(options); */'],
    ['a call in a string', "const text = 'await runHeadless(config)';"],
    ['a mocked sdk module', "vi.mock('./sdk.js', () => ({ query: vi.fn() }));"],
  ])('does not flag %s', (_name, source) => {
    expect(unpinned(source)).toEqual([]);
  });

  it('reports the line of each unpinned drive point', () => {
    expect(unpinned('const a = 1;\n\nawait runHeadless(a);\nawait runMainAction(a);')).toEqual([
      3, 4,
    ]);
  });
});

describe('what pins BOOK_HOME for a drive point', () => {
  const drive = "it('runs', async () => {\n  await runHeadless(config);\n});";

  it.each([
    ['a top-level isolateBookHome', `isolateBookHome('x-');\n${drive}`],
    ['a top-level isolateBookHome kept in a variable', `const home = isolateBookHome();\n${drive}`],
    [
      'a top-level beforeEach assignment',
      `beforeEach(() => {\n  process.env.BOOK_HOME = home;\n});\n${drive}`,
    ],
    [
      'a top-level beforeAll assignment',
      `beforeAll(() => {\n  process.env['BOOK_HOME'] = home;\n});\n${drive}`,
    ],
    ['a top-level assignment', `process.env.BOOK_HOME = home;\n${drive}`],
    ['a top-level vi.stubEnv', `vi.stubEnv('BOOK_HOME', home);\n${drive}`],
    ['a top-level stashEnv', `stashEnv('BOOK_HOME', home);\n${drive}`],
    [
      'a pin earlier in the same it',
      `it('runs', async () => {\n  stashEnv('BOOK_HOME', h);\n  await runHeadless(c);\n});`,
    ],
    [
      'a pin in a helper function, which counts for the whole file',
      `function makeConfig() {\n  process.env.BOOK_HOME = tempDir();\n}\n${drive}`,
    ],
    [
      'a pin in an arrow helper',
      `const launch = async () => {\n  stashEnv('BOOK_HOME', home);\n};\n${drive}`,
    ],
    [
      'a pin in the beforeEach of the describe that holds the drive point',
      `describe('a', () => {\n  beforeEach(() => {\n    process.env.BOOK_HOME = h;\n  });\n  ${drive}\n});`,
    ],
    [
      'an isolateBookHome inside the describe that holds the drive point',
      `describe('a', () => {\n  isolateBookHome();\n  ${drive}\n});`,
    ],
    [
      'a pin next to a glob string that a comment regex would mistake for a comment',
      `const glob = 'src/**/*.ts';\nprocess.env.BOOK_HOME = home;\nconst other = 'https://x.test'; // done\n${drive}`,
    ],
  ])('accepts %s', (_name, source) => {
    expect(unpinned(source)).toEqual([]);
  });

  it.each([
    ['no pin at all', drive],
    [
      'only a restore in afterEach',
      `const previous = process.env.BOOK_HOME;\nafterEach(() => {\n  if (previous === undefined) delete process.env.BOOK_HOME;\n  else process.env.BOOK_HOME = previous;\n});\n${drive}`,
    ],
    [
      'only a restore of a saved value, outside any afterEach',
      `let saved: string | undefined;\nbeforeEach(() => {\n  saved = process.env.BOOK_HOME;\n});\nfunction restore() {\n  process.env.BOOK_HOME = saved;\n}\n${drive}`,
    ],
    [
      'an assignment in afterEach, whatever it assigns',
      `afterEach(() => {\n  process.env.BOOK_HOME = '/somewhere';\n});\n${drive}`,
    ],
    ['an afterAll stubEnv', `afterAll(() => {\n  vi.stubEnv('BOOK_HOME', '');\n});\n${drive}`],
    [
      'a pin only in a finally block',
      `it('a', async () => {\n  try {\n    await runHeadless(c);\n  } finally {\n    process.env.BOOK_HOME = '/x';\n  }\n});`,
    ],
    [
      'a pin in one it with the runner called in another',
      `it('pins', () => {\n  process.env.BOOK_HOME = home;\n});\n${drive}`,
    ],
    [
      'a pin later in the same it than the call',
      `it('late', async () => {\n  await runHeadless(c);\n  process.env.BOOK_HOME = home;\n});`,
    ],
    [
      'an isolateBookHome in one describe, the call in a sibling',
      `describe('a', () => {\n  isolateBookHome();\n});\ndescribe('b', () => {\n  ${drive}\n});`,
    ],
    [
      'a beforeEach pin in one describe, the call at the top level',
      `describe('a', () => {\n  beforeEach(() => {\n    process.env.BOOK_HOME = h;\n  });\n});\n${drive}`,
    ],
    ['a mention of BOOK_HOME in a comment', `// process.env.BOOK_HOME = home;\n${drive}`],
    ['a mention in a block comment', `/* isolateBookHome(); */\n${drive}`],
    ['a mention in a string', `const s = "process.env.BOOK_HOME = home";\n${drive}`],
    ['a read', `expect(process.env.BOOK_HOME).toBe('x');\n${drive}`],
    ['a comparison', `if (process.env.BOOK_HOME === 'x') {}\n${drive}`],
    ['a stubEnv of another variable', `vi.stubEnv('BOOK_API_KEY', 'k');\n${drive}`],
  ])('rejects %s', (_name, source) => {
    expect(unpinned(source)).not.toEqual([]);
  });

  it('covers a drive point only inside the describe that holds the pin', () => {
    const source = [
      "describe('pinned', () => {",
      '  isolateBookHome();',
      "  it('a', async () => {",
      '    await runHeadless(c);',
      '  });',
      '});',
      "describe('not pinned', () => {",
      "  it('b', async () => {",
      '    await runHeadless(c);',
      '  });',
      '});',
    ].join('\n');
    expect(unpinned(source)).toEqual([9]);
  });
});

// A suite that drives the print-mode runner (directly, or through the SDK) without a
// pinned home writes each run's record into the developer's real ~/.book/runs (#421).
describe('the suites', () => {
  it('pin BOOK_HOME wherever they drive the print-mode runner', () => {
    const gaps = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.test\.tsx?$/.test(file))
      .flatMap((file) =>
        unpinnedDriveLines(readFileSync(join(SRC, file), 'utf8'), file).map(
          (line) => `${file.split('\\').join('/')}:${line}`,
        ),
      )
      .sort();
    expect(gaps).toEqual([]);
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
