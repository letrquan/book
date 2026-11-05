import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  BASELINE_REPO_PATH,
  baselineAtRef,
  checkArchitecture,
  checkBaselineAgainstBase,
  generateBaseline,
  lowerBaseline,
  measureFunctionSizes,
  parseBaseline,
  runArchitectureCli,
  serializeBaseline,
  type FunctionSizeBaseline,
} from './check-architecture.js';
import { gitIn } from '../src/test/git-fixtures.js';

describe('checkArchitecture', () => {
  it('rejects a new non-TUI import from tui/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'tui'));
      writeFileSync(join(dir, 'worker.ts'), "import './tui/view.js';\n");
      writeFileSync(join(dir, 'tui', 'view.ts'), 'export {};\n');
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({ kind: 'layer', source: 'worker.ts', target: 'tui/view.ts' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects every import cycle without an exception ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'first.ts'), "import './second.js';\n");
      writeFileSync(join(dir, 'second.ts'), "import './first.js';\n");

      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'cycle',
          detail: 'Import cycle: first.ts -> second.ts -> first.ts',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects reintroducing the removed compatibility type hub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'types.ts'), 'export interface Everything {}\n');
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({ kind: 'type-hub', source: 'types.ts', target: 'types/' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects blocking child-process APIs in production source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(
        join(dir, 'worker.ts'),
        "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);\n",
      );
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'blocking-process',
          source: 'worker.ts',
          target: 'child_process',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a static React or Ink import the CLI entry reaches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'cli'));
      writeFileSync(join(dir, 'index.ts'), "import './cli/run.js';\n");
      writeFileSync(
        join(dir, 'cli', 'run.ts'),
        "import { render } from 'ink';\nimport type { Instance } from 'ink';\nexport { render };\n",
      );
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({ kind: 'eager-react', source: 'cli/run.ts', target: 'ink' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows React behind a dynamic import and outside the CLI entry graph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'cli'));
      writeFileSync(join(dir, 'index.ts'), "import './cli/run.js';\n");
      writeFileSync(
        join(dir, 'cli', 'run.ts'),
        "export async function start() {\n  const { render } = await import('ink');\n" +
          "  const { App } = await import('../view.js');\n  return [render, App];\n}\n",
      );
      writeFileSync(
        join(dir, 'view.tsx'),
        "import { Text } from 'ink';\nexport const App = () => <Text>hi</Text>;\n",
      );
      expect(checkArchitecture(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a TSX module the CLI entry reaches as a React import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'index.ts'), "import './banner.js';\n");
      writeFileSync(join(dir, 'banner.tsx'), 'export const Banner = () => null;\n');
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'eager-react',
          source: 'banner.tsx',
          target: 'react/jsx-runtime',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkArchitecture process termination', () => {
  it('rejects a direct process.exit() outside the exit abstraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'cli'));
      writeFileSync(join(dir, 'cli', 'thing.ts'), 'export function f() {\n  process.exit(1);\n}\n');

      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'process-exit',
          source: 'cli/thing.ts',
          target: 'cli/exit.ts',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Entry points are spawned as their own process, so they own when it ends.
  it('allows a build entry point to terminate its own process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'job-runner.ts'), 'process.exit(1);\n');

      expect(checkArchitecture(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Documentation that names the banned call must not read as a violation.
  it('ignores process.exit() mentioned in a comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(
        join(dir, 'note.ts'),
        '/**\n * Prefer exit() instead of calling process.exit() directly.\n */\nexport {};\n',
      );

      expect(checkArchitecture(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('function size ratchet', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    dirs.push(dir);
    return dir;
  };
  const writeFiles = (dir: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  };
  const source = (files: Record<string, string>): string => {
    const dir = tempDir();
    writeFiles(dir, files);
    return dir;
  };
  const measure = (files: Record<string, string>) => measureFunctionSizes(source(files));

  /** A function of exactly `lines` code lines and complexity 1. */
  const longFunction = (name: string, lines: number): string =>
    `export function ${name}() {\n` +
    Array.from({ length: lines - 2 }, (_, i) => `  const v${i} = ${i};\n`).join('') +
    '}\n';
  /** A function of complexity `complexity` and `complexity + 1` code lines. */
  const branchyFunction = (name: string, complexity: number): string =>
    `export function ${name}(a: boolean) {\n` + '  if (a) return;\n'.repeat(complexity - 1) + '}\n';

  describe('measuring', () => {
    it('counts only lines that hold a token, whichever comment form the rest use', () => {
      const sizes = measure({
        'a.ts':
          'export function f() {\n\n  // line comment\n  /* block\n     comment */\n' +
          '  /**\n   * attached doc comment\n   */\n  const x = 1; // trailing\n  return x;\n}\n',
      });
      expect(sizes.get('a.ts#f')).toEqual({ codeLines: 4, complexity: 1 });
    });

    it('leaves out an empty JSX expression holding only a comment', () => {
      const sizes = measure({
        'a.tsx':
          'export function V() {\n  return (\n    <a>\n      {/* why */}\n\n      text\n' +
          '    </a>\n  );\n}\n',
      });
      expect(sizes.get('a.tsx#V')?.codeLines).toBe(7);
    });

    it('counts every line of a multi-line string, blank ones included', () => {
      const sizes = measure({ 'a.ts': 'export function f() {\n  return `a\n\nb`;\n}\n' });
      expect(sizes.get('a.ts#f')?.codeLines).toBe(5);
    });

    it('adds one for each listed branch and nothing else', () => {
      const sizes = measure({
        'a.ts': `export function f(a: boolean, b: number[]) {
  if (a) return 1;
  for (let i = 0; i < 1; i++) {}
  for (const x of b) {}
  for (const x in b) {}
  while (a) {}
  do {} while (a);
  try {} catch {}
  switch (1) { case 1: break; default: break; }
  const c = a ? 1 : 2;
  const d = a && b;
  const e = a || b;
  const g = a ?? b;
  let h: number | undefined;
  h ??= 1;
  return b?.length;
}
`,
      });
      expect(sizes.get('a.ts#f')?.complexity).toBe(13);
    });

    it("counts a nested function's lines toward its parent but its branches only toward itself", () => {
      const sizes = measure({
        'a.ts':
          'export function outer(a: boolean) {\n  if (a) return;\n  const inner = () => {\n' +
          '    if (a) return;\n    if (!a) return;\n  };\n  return inner;\n}\n',
      });
      expect(sizes.get('a.ts#outer')).toEqual({ codeLines: 8, complexity: 2 });
      expect(sizes.get('a.ts#outer>inner')).toEqual({ codeLines: 4, complexity: 3 });
    });

    it('skips a signature with no body', () => {
      const sizes = measure({
        'a.ts':
          'export function f(a: string): void;\nexport function f(a: number): void;\n' +
          'export function f(a: unknown): void {}\nabstract class C {\n  abstract g(): void;\n}\n',
      });
      expect([...sizes.keys()]).toEqual(['a.ts#f']);
    });

    it('measures production source only', () => {
      const sizes = measure({
        'a.ts': 'export function f() {}\n',
        'a.test.ts': 'export function g() {}\n',
        'a.test.tsx': 'export function g() {}\n',
        'test/double.ts': 'export function h() {}\n',
        'tui/__benchmarks__/ui.bench.tsx': 'export function i() {}\n',
        'tui/view.tsx': 'export function j() {}\n',
      });
      expect([...sizes.keys()].sort()).toEqual(['a.ts#f', 'tui/view.tsx#j']);
    });

    it('gives the same keys and numbers when a file has CRLF line endings', () => {
      const text =
        'export const f = () => {\n\n  // why\n  const s = `a\n\nb`;\n  return s;\n};\n' +
        'export function V() {\n  return (\n    <a>\n      text\n\n      more\n    </a>\n  );\n}\n';
      const lf = measure({ 'dir/a.tsx': text });
      const crlf = measure({ 'dir/a.tsx': text.replaceAll('\n', '\r\n') });
      expect([...crlf]).toEqual([...lf]);
      expect([...lf.keys()]).toEqual(['dir/a.tsx#f', 'dir/a.tsx#V']);
    });
  });

  describe('identity', () => {
    it('names a function from its declaration or assignment target, through a wrapping call', () => {
      const sizes = measure({
        'a.ts': `const send = useCallback(() => {}, []);
const own = memo(function Named() {});
const cast = (() => {}) as Fn;
const waited = await run(() => {});
const built = new Promise(() => {});
const table = { run() {}, stop: () => {} };
target.later = function () {};
function withDefault(cb = () => {}) {}
export class Agent {
  constructor() {}
  spawn() {
    const step = () => {};
  }
  get x() { return 1; }
  set x(v) {}
  handler = () => {};
}
export default function () {}
`,
      });
      expect([...sizes.keys()].sort()).toEqual(
        [
          'a.ts#send',
          'a.ts#Named',
          'a.ts#cast',
          'a.ts#waited',
          'a.ts#built',
          'a.ts#run',
          'a.ts#stop',
          'a.ts#later',
          'a.ts#withDefault',
          'a.ts#withDefault>cb',
          'a.ts#Agent>constructor',
          'a.ts#Agent>spawn',
          'a.ts#Agent>spawn>step',
          'a.ts#Agent>get x',
          'a.ts#Agent>set x',
          'a.ts#Agent>handler',
          'a.ts#default',
        ].sort(),
      );
    });

    it('names a callback nobody assigned from the call it is passed to', () => {
      const sizes = measure({
        'a.tsx': `export function View() {
  useEffect(() => {}, []);
  useInput(() => {});
  useEffect(() => {}, []);
  items.map(() => 1);
  run().then(() => 1).catch(() => 2);
  return new Promise(() => {});
}
`,
      });
      expect([...sizes.keys()]).toEqual([
        'a.tsx#View',
        'a.tsx#View>useEffect',
        'a.tsx#View>useInput',
        'a.tsx#View>useEffect~2',
        'a.tsx#View>map',
        'a.tsx#View>then',
        'a.tsx#View>catch',
        'a.tsx#View>Promise',
      ]);
    });

    it('does not rename a callback when one of another callee is added above it', () => {
      const body = (above: string) =>
        `export function View() {\n${above}  useInput(() => {});\n}\n`;
      expect(measure({ 'a.tsx': body('') }).has('a.tsx#View>useInput')).toBe(true);
      const added = measure({
        'a.tsx': body('  useEffect(() => {}, []);\n  items.map(() => 1);\n'),
      });
      expect(added.has('a.tsx#View>useInput')).toBe(true);
    });

    it('gives unnamed functions an ordinal within their own scope, in source order', () => {
      const sizes = measure({
        'a.ts': `export const table = [() => 1, () => 2];
(() => 3)();
export function f() {
  return [() => 4];
}
`,
      });
      expect([...sizes.keys()]).toEqual([
        'a.ts#<anon>1',
        'a.ts#<anon>2',
        'a.ts#<anon>3',
        'a.ts#f',
        'a.ts#f><anon>1',
      ]);
    });

    it('keeps two functions with one name in one scope apart', () => {
      const sizes = measure({
        'a.ts':
          'const both = pair(() => 1, () => 2);\nconst one = { a() {} };\nconst two = { a() {} };\n',
      });
      expect([...sizes.keys()]).toEqual(['a.ts#both', 'a.ts#both~2', 'a.ts#a', 'a.ts#a~2']);
    });

    it('refuses two functions that would share a key, rather than dropping one', () => {
      const text = "const one = { x: () => 1, 'x~2': () => 2 };\nconst two = { x: () => 3 };\n";
      expect(() => measure({ 'a.ts': text })).toThrow('share the key a.ts#x~2');
    });
  });

  describe('rule 1: over the limit with no baseline entry', () => {
    it('allows exactly 150 code lines and complexity 30', () => {
      const dir = source({
        'long.ts': longFunction('long', 150),
        'branchy.ts': branchyFunction('branchy', 30),
      });
      expect(checkArchitecture(dir)).toEqual([]);
    });

    it('rejects 151 code lines', () => {
      const dir = source({ 'long.ts': longFunction('long', 151) });
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: 'long.ts#long',
          detail: expect.stringContaining('151 code lines'),
        }),
      ]);
    });

    it('rejects complexity 31', () => {
      const dir = source({ 'branchy.ts': branchyFunction('branchy', 31) });
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: 'branchy.ts#branchy',
          detail: expect.stringContaining('complexity 31'),
        }),
      ]);
    });

    it('treats a rename as a new function', () => {
      const dir = source({ 'long.ts': longFunction('renamed', 200) });
      const baseline = { 'long.ts#long': { codeLines: 200, complexity: 1 } };
      expect(checkArchitecture(dir, baseline).map((violation) => violation.source)).toEqual([
        'long.ts#long',
        'long.ts#renamed',
      ]);
    });
  });

  describe('rule 2: a baselined function grew', () => {
    it('passes when both numbers match', () => {
      const dir = source({ 'long.ts': longFunction('long', 200) });
      const baseline = { 'long.ts#long': { codeLines: 200, complexity: 1 } };
      expect(checkArchitecture(dir, baseline)).toEqual([]);
    });

    it('rejects a higher line count', () => {
      const dir = source({ 'long.ts': longFunction('long', 201) });
      const baseline = { 'long.ts#long': { codeLines: 200, complexity: 1 } };
      expect(checkArchitecture(dir, baseline)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: 'long.ts#long',
          detail: expect.stringContaining('above its baseline'),
        }),
      ]);
    });

    it('rejects a higher complexity even when it stays under the limit', () => {
      const dir = source({
        'long.ts': longFunction('long', 200).replace('const v0 = 0;', 'if (Date.now()) return;'),
      });
      const baseline = { 'long.ts#long': { codeLines: 200, complexity: 1 } };
      expect(checkArchitecture(dir, baseline)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          detail: expect.stringContaining('above its baseline'),
        }),
      ]);
    });

    it('does not count a change that only adds comments and blank lines', () => {
      const text = longFunction('long', 200);
      const baseline = generateBaseline(measure({ 'long.ts': text }));
      const commented = text.replace(
        'const v0 = 0;',
        '// why\n\n  /* more\n     why */\n  /** even more */\n  const v0 = 0;',
      );
      expect(checkArchitecture(source({ 'long.ts': commented }), baseline)).toEqual([]);
    });
  });

  describe('rule 3: a gain nobody recorded', () => {
    const expectStale = (dir: string, baseline: FunctionSizeBaseline, key: string): void => {
      expect(checkArchitecture(dir, baseline)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: key,
          detail: expect.stringContaining('npm run architecture:baseline'),
        }),
      ]);
    };

    it('rejects a function below a recorded number', () => {
      const dir = source({ 'long.ts': longFunction('long', 199) });
      expectStale(dir, { 'long.ts#long': { codeLines: 200, complexity: 1 } }, 'long.ts#long');
    });

    it('rejects a function that is gone', () => {
      const dir = source({ 'other.ts': 'export function f() {}\n' });
      expectStale(dir, { 'long.ts#long': { codeLines: 200, complexity: 1 } }, 'long.ts#long');
    });

    it('rejects an entry for a function back within the limits', () => {
      const dir = source({ 'long.ts': longFunction('long', 150) });
      expectStale(dir, { 'long.ts#long': { codeLines: 150, complexity: 1 } }, 'long.ts#long');
    });
  });

  describe('updating the baseline', () => {
    const big = { codeLines: 500, complexity: 40 };

    it('lowers numbers and removes entries that are gone or back within the limits', () => {
      const measured = new Map([
        ['a.ts#shrank', { codeLines: 400, complexity: 35 }],
        ['a.ts#within', { codeLines: 150, complexity: 30 }],
      ]);
      const next = lowerBaseline(
        { 'a.ts#shrank': big, 'a.ts#within': big, 'a.ts#gone': big },
        measured,
      );
      expect(next).toEqual({ 'a.ts#shrank': { codeLines: 400, complexity: 35 } });
    });

    it('refuses to raise a number, so the check still fails', () => {
      const measured = new Map([['a.ts#grew', { codeLines: 600, complexity: 30 }]]);
      expect(lowerBaseline({ 'a.ts#grew': big }, measured)).toEqual({
        'a.ts#grew': { codeLines: 500, complexity: 30 },
      });
    });

    it('refuses to add an entry', () => {
      const measured = new Map([['a.ts#new', big]]);
      expect(lowerBaseline({}, measured)).toEqual({});
    });

    it('keeps movedFrom', () => {
      const entry = { ...big, movedFrom: 'b.ts#old' };
      const measured = new Map([['a.ts#moved', { codeLines: 450, complexity: 40 }]]);
      expect(lowerBaseline({ 'a.ts#moved': entry }, measured)).toEqual({
        'a.ts#moved': { codeLines: 450, complexity: 40, movedFrom: 'b.ts#old' },
      });
    });

    it('generates entries only for functions over the limits', () => {
      const measured = new Map([
        ['a.ts#within', { codeLines: 150, complexity: 30 }],
        ['a.ts#lines', { codeLines: 151, complexity: 1 }],
        ['a.ts#branches', { codeLines: 40, complexity: 31 }],
      ]);
      expect(generateBaseline(measured)).toEqual({
        'a.ts#lines': { codeLines: 151, complexity: 1 },
        'a.ts#branches': { codeLines: 40, complexity: 31 },
      });
    });

    it('writes one sorted entry per line, and reads it back', () => {
      const baseline = {
        'b.ts#f': { codeLines: 200, complexity: 1 },
        'a.ts#f': { codeLines: 300, complexity: 2, movedFrom: 'c.ts#f' },
      };
      const text = serializeBaseline(baseline);
      expect(text).toBe(
        '{\n' +
          '  "a.ts#f": { "codeLines": 300, "complexity": 2, "movedFrom": "c.ts#f" },\n' +
          '  "b.ts#f": { "codeLines": 200, "complexity": 1 }\n' +
          '}\n',
      );
      expect(parseBaseline(text)).toEqual(baseline);
      expect(parseBaseline(serializeBaseline({}))).toEqual({});
    });

    it.each([
      ['not JSON', '{'],
      ['an array', '[]'],
      ['a missing number', '{ "a.ts#f": { "codeLines": 200 } }'],
      ['a fraction', '{ "a.ts#f": { "codeLines": 200.5, "complexity": 1 } }'],
      ['a misspelt field', '{ "a.ts#f": { "codeLines": 200, "complexity": 1, "movedfrom": "x" } }'],
    ])('rejects a baseline file holding %s', (_label, text) => {
      expect(() => parseBaseline(text)).toThrow();
    });
  });

  describe('rule 4: compared with the base branch', () => {
    const base: FunctionSizeBaseline = {
      'a.ts#old': { codeLines: 500, complexity: 40 },
      'a.ts#other': { codeLines: 300, complexity: 10 },
    };

    it('passes an unchanged or lowered baseline', () => {
      expect(checkBaselineAgainstBase(base, base)).toEqual([]);
      expect(
        checkBaselineAgainstBase({ 'a.ts#old': { codeLines: 499, complexity: 39 } }, base),
      ).toEqual([]);
    });

    it('rejects a gained key', () => {
      const head = { ...base, 'a.ts#new': { codeLines: 151, complexity: 1 } };
      expect(checkBaselineAgainstBase(head, base)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: 'a.ts#new',
          detail: expect.stringContaining('gains'),
        }),
      ]);
    });

    it.each([
      ['code lines', { codeLines: 501, complexity: 40 }],
      ['complexity', { codeLines: 500, complexity: 41 }],
    ])('rejects raised %s', (_label, raised) => {
      expect(checkBaselineAgainstBase({ ...base, 'a.ts#old': raised }, base)).toEqual([
        expect.objectContaining({
          kind: 'function-size',
          source: 'a.ts#old',
          detail: expect.stringContaining('raises'),
        }),
      ]);
    });

    describe('movedFrom', () => {
      const moved = { codeLines: 400, complexity: 35, movedFrom: 'a.ts#old' };
      const headWith = (
        claims: Record<string, FunctionSizeBaseline[string]>,
        left?: FunctionSizeBaseline[string],
      ): FunctionSizeBaseline => ({
        'a.ts#other': base['a.ts#other'],
        ...claims,
        ...(left ? { 'a.ts#old': left } : {}),
      });
      const claim = (codeLines: number, complexity: number) => ({
        codeLines,
        complexity,
        movedFrom: 'a.ts#old',
      });

      it('accepts a move whose source is gone', () => {
        expect(checkBaselineAgainstBase(headWith({ 'b.ts#moved': moved }), base)).toEqual([]);
      });

      it('accepts a move whose source shrank by what moved out', () => {
        const head = headWith({ 'b.ts#moved': moved }, { codeLines: 120, complexity: 6 });
        expect(checkBaselineAgainstBase(head, base)).toEqual([]);
      });

      it('accepts one source split between two new functions', () => {
        const head = headWith({ 'b.ts#one': claim(300, 20), 'b.ts#two': claim(260, 22) });
        expect(checkBaselineAgainstBase(head, base)).toEqual([]);
      });

      it('allows a new function its signature and base complexity, and no more', () => {
        const atAllowance = headWith({ 'b.ts#moved': claim(530, 41) });
        expect(checkBaselineAgainstBase(atAllowance, base)).toEqual([]);
        for (const over of [claim(531, 41), claim(530, 42)]) {
          expect(checkBaselineAgainstBase(headWith({ 'b.ts#moved': over }), base)).toEqual([
            expect.objectContaining({
              source: 'a.ts#old',
              detail: expect.stringContaining('gone or smaller'),
            }),
          ]);
        }
      });

      it('rejects a move whose source is unchanged', () => {
        const head = headWith({ 'b.ts#moved': moved }, base['a.ts#old']);
        expect(checkBaselineAgainstBase(head, base)).toEqual([
          expect.objectContaining({
            source: 'a.ts#old',
            detail: expect.stringContaining('gone or smaller'),
          }),
        ]);
      });

      it('rejects a source that shrank by less than what moved out', () => {
        const head = headWith({ 'b.ts#moved': moved }, { codeLines: 499, complexity: 39 });
        expect(checkBaselineAgainstBase(head, base)).toHaveLength(1);
      });

      it('rejects spending one source twice', () => {
        const head = headWith({ 'b.ts#one': claim(500, 40), 'b.ts#two': claim(500, 40) });
        expect(checkBaselineAgainstBase(head, base)).toEqual([
          expect.objectContaining({
            source: 'a.ts#old',
            detail: expect.stringContaining('b.ts#one, b.ts#two'),
          }),
        ]);
      });

      it('rejects a source the base branch does not have', () => {
        for (const missing of ['a.ts#nope', 'constructor', '__proto__']) {
          const head = { ...base, 'b.ts#moved': { ...moved, movedFrom: missing } };
          expect(checkBaselineAgainstBase(head, base)).toEqual([
            expect.objectContaining({ source: 'b.ts#moved' }),
          ]);
        }
      });

      it('ignores the field once the key exists on the base branch', () => {
        const onBase = { ...base, 'a.ts#other': { ...base['a.ts#other'], movedFrom: 'a.ts#old' } };
        expect(checkBaselineAgainstBase(onBase, base)).toEqual([]);
        const raised = { ...onBase, 'a.ts#other': { ...onBase['a.ts#other'], codeLines: 301 } };
        expect(checkBaselineAgainstBase(raised, base)).toEqual([
          expect.objectContaining({
            source: 'a.ts#other',
            detail: expect.stringContaining('raises'),
          }),
        ]);
      });

      // The route #705 takes: extract, hand-add the entry, run the update, and all four rules pass.
      it('passes end to end when an extraction is recorded by hand and then updated', () => {
        const before = {
          'host.ts': `export function host() {\n  return 1;\n${'  // padding\n'.repeat(2)}}\n`,
          'loop.ts': longFunction('old', 200),
        };
        const baseOnMain = generateBaseline(measure(before));
        expect(checkArchitecture(source(before), baseOnMain)).toEqual([]);

        const dir = source({
          'host.ts': before['host.ts'],
          'loop.ts': 'export function old() {}\n',
          'moved.ts': longFunction('moved', 200),
        });
        // Before the entry exists: rule 1 for the new key, rule 3 for the old one.
        expect(checkArchitecture(dir, baseOnMain).map((violation) => violation.source)).toEqual([
          'loop.ts#old',
          'moved.ts#moved',
        ]);

        const handEdited = {
          ...baseOnMain,
          'moved.ts#moved': { codeLines: 200, complexity: 1, movedFrom: 'loop.ts#old' },
        };
        const updated = lowerBaseline(handEdited, measureFunctionSizes(dir));
        expect(updated).toEqual({
          'moved.ts#moved': { codeLines: 200, complexity: 1, movedFrom: 'loop.ts#old' },
        });
        expect(checkArchitecture(dir, updated)).toEqual([]);
        expect(checkBaselineAgainstBase(updated, baseOnMain)).toEqual([]);
      });
    });

    describe('reading the base baseline from git', () => {
      const repoWith = async (files: Record<string, string>): Promise<string> => {
        const dir = tempDir();
        await gitIn(dir, 'init', '-q');
        writeFiles(dir, { 'README.md': 'x\n', ...files });
        await gitIn(dir, 'add', '.');
        await gitIn(
          dir,
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgSign=false',
          'commit',
          '-qm',
          'x',
        );
        return dir;
      };

      it('reads the file at the ref', async () => {
        const dir = await repoWith({
          [BASELINE_REPO_PATH]: '{ "a.ts#f": { "codeLines": 200, "complexity": 1 } }\n',
        });
        await expect(baselineAtRef('HEAD', dir)).resolves.toEqual({
          'a.ts#f': { codeLines: 200, complexity: 1 },
        });
      });

      it('returns null when the ref has no baseline yet', async () => {
        await expect(baselineAtRef('HEAD', await repoWith({}))).resolves.toBeNull();
      });

      // Neither must read as "no baseline yet": that would turn rule 4 off.
      it('throws on a ref that does not resolve', async () => {
        await expect(baselineAtRef('origin/nope', await repoWith({}))).rejects.toThrow();
      });

      it('throws when git itself fails', async () => {
        await expect(baselineAtRef('HEAD', tempDir())).rejects.toThrow();
      });

      it('compares the working baseline with the ref, and rule 4 alone', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const entry = '{ "a.ts#f": { "codeLines": 200, "complexity": 1 } }\n';
        const dir = await repoWith({ [BASELINE_REPO_PATH]: entry });
        // A function over the limit with no entry, which rule 1 would reject.
        writeFiles(dir, { 'src/long.ts': longFunction('long', 151) });
        await expect(runArchitectureCli(['--base-ref', 'HEAD'], dir)).resolves.toBe(0);

        writeFiles(dir, {
          [BASELINE_REPO_PATH]: '{ "a.ts#f": { "codeLines": 201, "complexity": 1 } }\n',
        });
        await expect(runArchitectureCli(['--base-ref', 'HEAD'], dir)).resolves.toBe(1);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('raises'));
        vi.restoreAllMocks();
      });
    });
  });

  describe('the command line', () => {
    const repo = (files: Record<string, string>): string => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      return source(files);
    };
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const readEntries = (dir: string): FunctionSizeBaseline =>
      parseBaseline(readFileSync(join(dir, BASELINE_REPO_PATH), 'utf-8'));
    const scripts = { 'scripts/.keep': '' };

    it('generates the file when there is none, and only then', async () => {
      const dir = repo({ ...scripts, 'src/long.ts': longFunction('long', 200) });
      await expect(runArchitectureCli(['--update-baseline'], dir)).resolves.toBe(0);
      expect(readEntries(dir)).toEqual({ 'long.ts#long': { codeLines: 200, complexity: 1 } });
      await expect(runArchitectureCli([], dir)).resolves.toBe(0);

      writeFiles(dir, { 'src/new.ts': longFunction('fresh', 151) });
      await expect(runArchitectureCli(['--update-baseline'], dir)).resolves.toBe(1);
      expect(Object.keys(readEntries(dir))).toEqual(['long.ts#long']);
    });

    it('fails an update that would have to raise a number, and leaves the number', async () => {
      const dir = repo({ ...scripts, 'src/long.ts': longFunction('long', 201) });
      writeFiles(dir, {
        [BASELINE_REPO_PATH]: '{ "long.ts#long": { "codeLines": 200, "complexity": 1 } }\n',
      });
      await expect(runArchitectureCli(['--update-baseline'], dir)).resolves.toBe(1);
      expect(readEntries(dir)['long.ts#long'].codeLines).toBe(200);
    });

    it.each([['--update-baseline'], ['--base-ref=HEAD']])(
      'refuses %s with another source root, and leaves the file alone',
      async (flag) => {
        const entry = '{ "agent/long.ts#long": { "codeLines": 200, "complexity": 1 } }\n';
        const dir = repo({
          [BASELINE_REPO_PATH]: entry,
          'src/agent/long.ts': longFunction('long', 200),
        });
        await expect(runArchitectureCli([flag, join(dir, 'src', 'agent')], dir)).resolves.toBe(1);
        expect(readFileSync(join(dir, BASELINE_REPO_PATH), 'utf-8')).toBe(entry);
      },
    );

    it('does not read the baseline against another source root', async () => {
      const dir = repo({
        [BASELINE_REPO_PATH]: '{ "agent/long.ts#long": { "codeLines": 200, "complexity": 1 } }\n',
        'src/agent/small.ts': 'export function f() {}\n',
      });
      await expect(runArchitectureCli([join(dir, 'src', 'agent')], dir)).resolves.toBe(0);
      expect(existsSync(join(dir, BASELINE_REPO_PATH))).toBe(true);
    });
  });
});
