import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import ts from 'typescript';

interface Violation {
  kind:
    | 'layer'
    | 'entrypoint'
    | 'cycle'
    | 'type-hub'
    | 'blocking-process'
    | 'process-exit'
    | 'eager-react'
    | 'function-size';
  source: string;
  target: string;
  detail: string;
}

const IMPORT_PATTERN = /(?:import|export)\s+(type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const CHILD_PROCESS_IMPORT_PATTERN = /from\s+['"](?:node:)?child_process['"]/;
const SYNC_PROCESS_API_PATTERN = /\b(?:execFileSync|execSync|spawnSync)\b/;
const PROCESS_EXIT_PATTERN = /\bprocess\.exit\s*\(/;
/**
 * Specifiers that evaluate React. `runtime-env.ts` defaults NODE_ENV to "production" so React
 * loads its production build, but the CLI is a split bundle that hoists every static import of
 * the entry above the entry's own body. Whatever the entry reaches through static imports is
 * therefore evaluated before NODE_ENV is set, so the TUI must load these with `import()`.
 */
const REACT_SPECIFIER_PATTERN = /^(?:ink|react|react-reconciler|react-dom)(?:\/|$)/;
const CLI_ENTRY = 'index.ts';
/**
 * Modules allowed to terminate the process directly. Build entry points own their
 * own process lifetime, and `cli/exit.ts` is the injectable seam itself. Everything
 * else must call `exit()` so tests can capture the code instead of dying.
 */
const PROCESS_LIFETIME_OWNERS = new Set([
  'index.ts',
  'sdk.ts',
  'job-runner.ts',
  'job-supervisor.ts',
  'cli/exit.ts',
]);

/** True when the file really calls process.exit(), ignoring mentions in comments. */
function callsProcessExit(text: string): boolean {
  return text.split('\n').some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return false;
    }
    return PROCESS_EXIT_PATTERN.test(line);
  });
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = resolve(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.(?:ts|tsx)$/.test(entry) && !/\.test\.(?:ts|tsx)$/.test(entry)) files.push(path);
    }
  };
  visit(root);
  return files;
}

/** A function with no baseline entry may have at most this many code lines and this complexity. */
const FUNCTION_SIZE_LIMITS = { codeLines: 150, complexity: 30 };
/** Where the baseline lives, relative to the repository root. */
export const BASELINE_REPO_PATH = 'scripts/function-size-baseline.json';
const UPDATE_COMMAND = 'npm run architecture:baseline';
const UNNAMED = '<anon>';

export interface FunctionSize {
  codeLines: number;
  complexity: number;
}
export interface BaselineEntry extends FunctionSize {
  /** A key on the base branch this function was extracted from. See checkBaselineAgainstBase. */
  movedFrom?: string;
}
export type FunctionSizeBaseline = Record<string, BaselineEntry>;

const BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.ConditionalExpression,
]);
const BRANCH_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isBranch(node: ts.Node): boolean {
  return ts.isBinaryExpression(node)
    ? BRANCH_OPERATORS.has(node.operatorToken.kind)
    : BRANCH_KINDS.has(node.kind);
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined;
}

/** Nodes a function's value passes through on its way to the name it is assigned to. */
function isWrapper(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

function targetName(target: ts.Node): string | undefined {
  if (
    ts.isIdentifier(target) ||
    ts.isPrivateIdentifier(target) ||
    ts.isStringLiteralLike(target) ||
    ts.isNumericLiteral(target)
  ) {
    return target.text;
  }
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target)) return targetName(target.argumentExpression);
  if (ts.isComputedPropertyName(target)) return targetName(target.expression);
  return undefined;
}

/** The name a function or class goes by, from its declaration or the target it is assigned to. */
function scopeName(node: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const own = node.name && targetName(node.name);
  if (own) {
    if (ts.isGetAccessorDeclaration(node)) return `get ${own}`;
    if (ts.isSetAccessorDeclaration(node)) return `set ${own}`;
    return own;
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return 'default';

  let inner: ts.Node = node;
  while (isWrapper(inner.parent)) inner = inner.parent;
  const outer = inner.parent;
  if (ts.isExportAssignment(outer)) return 'default';
  if (ts.isBinaryExpression(outer)) {
    const assigns = outer.operatorToken.kind === ts.SyntaxKind.EqualsToken && outer.right === inner;
    return (assigns && targetName(outer.left)) || UNNAMED;
  }
  if (
    ts.isVariableDeclaration(outer) ||
    ts.isPropertyAssignment(outer) ||
    ts.isPropertyDeclaration(outer) ||
    ts.isParameter(outer) ||
    ts.isBindingElement(outer)
  ) {
    return (outer.initializer === inner && targetName(outer.name)) || UNNAMED;
  }
  return UNNAMED;
}

/**
 * For each line, how many lines up to and including it hold a token. A comment is trivia, not a
 * token, so comments and blank lines never count: this repo records its decisions in comments, and
 * a ratchet must not punish that.
 */
function countCodeLines(sourceFile: ts.SourceFile): number[] {
  const lineCount = sourceFile.getLineStarts().length;
  const holdsToken = new Array<boolean>(lineCount).fill(false);
  const lineAt = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line;
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    // `{/* why */}` is how JSX writes a comment. Its braces are tokens, but the line is a comment.
    if (ts.isJsxExpression(node) && !node.expression) return;
    if (ts.isJsxText(node)) {
      const text = sourceFile.text.slice(node.pos, node.end);
      for (const word of text.matchAll(/\S+/g)) holdsToken[lineAt(node.pos + word.index)] = true;
      return;
    }
    const children = node.getChildren(sourceFile);
    if (children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    const start = node.getStart(sourceFile);
    if (node.end <= start) return;
    for (let line = lineAt(start); line <= lineAt(node.end); line++) holdsToken[line] = true;
  };
  visit(sourceFile);

  let total = 0;
  return holdsToken.map((holds) => (total += holds ? 1 : 0));
}

function measureFile(path: string, text: string): Map<string, FunctionSize> {
  const sourceFile = ts.createSourceFile(
    path,
    // Line endings must not change a count, and Windows checks out with whichever git chose.
    text.replaceAll('\r\n', '\n'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const codeLinesUpTo = countCodeLines(sourceFile);
  const sizes = new Map<string, FunctionSize>();

  // Ordinals are per scope and in source order, so a function added elsewhere renames nothing here.
  const claimKey = (prefix: string, seen: Map<string, number>, name: string): string => {
    const ordinal = (seen.get(name) ?? 0) + 1;
    seen.set(name, ordinal);
    if (name === UNNAMED) return `${prefix}${name}${ordinal}`;
    return ordinal === 1 ? `${prefix}${name}` : `${prefix}${name}~${ordinal}`;
  };

  const visit = (
    node: ts.Node,
    prefix: string,
    seen: Map<string, number>,
    current: FunctionSize | undefined,
  ): void => {
    if (current && isBranch(node)) current.complexity += 1;
    if (isFunctionWithBody(node) || ts.isClassLike(node)) {
      const key = claimKey(prefix, seen, scopeName(node));
      let size = current;
      if (isFunctionWithBody(node)) {
        const first = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
        const last = sourceFile.getLineAndCharacterOfPosition(node.end).line;
        size = {
          codeLines: codeLinesUpTo[last] - (first > 0 ? codeLinesUpTo[first - 1] : 0),
          complexity: 1,
        };
        sizes.set(key, size);
      }
      const inner = new Map<string, number>();
      ts.forEachChild(node, (child) => visit(child, `${key}>`, inner, size));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, prefix, seen, current));
  };
  visit(sourceFile, `${path}#`, new Map(), undefined);
  return sizes;
}

/** Every production function under `srcRoot`, by key: `<path>#<outer>><name>`. */
export function measureFunctionSizes(srcRoot: string): Map<string, FunctionSize> {
  const root = resolve(srcRoot);
  const sizes = new Map<string, FunctionSize>();
  for (const file of sourceFiles(root)) {
    const sourceName = relative(root, file).replaceAll('\\', '/');
    if (sourceName.startsWith('test/') || sourceName.startsWith('tui/__benchmarks__/')) continue;
    for (const [key, size] of measureFile(sourceName, readFileSync(file, 'utf-8'))) {
      if (sizes.has(key)) throw new Error(`Two functions share the key ${key}.`);
      sizes.set(key, size);
    }
  }
  return sizes;
}

function isOverLimit(size: FunctionSize): boolean {
  return (
    size.codeLines > FUNCTION_SIZE_LIMITS.codeLines ||
    size.complexity > FUNCTION_SIZE_LIMITS.complexity
  );
}

function describeSize(size: FunctionSize): string {
  return `${size.codeLines} code lines, complexity ${size.complexity}`;
}

function isAbove(size: FunctionSize, ceiling: FunctionSize): boolean {
  return size.codeLines > ceiling.codeLines || size.complexity > ceiling.complexity;
}

function entryOf(baseline: FunctionSizeBaseline, key: string): BaselineEntry | undefined {
  return Object.hasOwn(baseline, key) ? baseline[key] : undefined;
}

/** Rules 1 to 3: every function is within the limits or matches its baseline entry exactly. */
function checkFunctionSizes(
  sizes: Map<string, FunctionSize>,
  baseline: FunctionSizeBaseline,
): Violation[] {
  const violations: Violation[] = [];
  const report = (source: string, detail: string) =>
    violations.push({ kind: 'function-size', source, target: BASELINE_REPO_PATH, detail });

  const recordGain = `Record the gain with \`${UPDATE_COMMAND}\`.`;
  for (const key of Object.keys(baseline).sort()) {
    const entry = baseline[key];
    const size = sizes.get(key);
    if (!size) {
      report(key, `This function is gone, but the baseline still lists it. ${recordGain}`);
    } else if (isAbove(size, entry)) {
      report(
        key,
        `Has ${describeSize(size)}, above its baseline of ${describeSize(entry)}. ` +
          'Take out at least as much as you add; the baseline only goes down.',
      );
    } else if (!isOverLimit(size)) {
      report(key, `Has ${describeSize(size)}, back within the limits. ${recordGain}`);
    } else if (size.codeLines < entry.codeLines || size.complexity < entry.complexity) {
      report(key, `Has ${describeSize(size)}, below its baseline. ${recordGain}`);
    }
  }
  for (const [key, size] of [...sizes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entryOf(baseline, key) || !isOverLimit(size)) continue;
    report(
      key,
      `Has ${describeSize(size)}; a new function may have at most ` +
        `${describeSize(FUNCTION_SIZE_LIMITS)}. Split it. A rename counts as new. If this code ` +
        `moved out of a baselined function, add "${key}": { "codeLines": ${size.codeLines}, ` +
        `"complexity": ${size.complexity}, "movedFrom": "<its old key>" } by hand, then run ` +
        `\`${UPDATE_COMMAND}\`.`,
    );
  }
  return violations;
}

/**
 * Rule 4: a pull request may not buy its way past rules 1 and 2 by editing the baseline, so against
 * the base branch the baseline may not gain a key or raise a number. The one exception is an
 * extraction, which is the point of the ratchet: a new key may name the base key it came from with
 * `movedFrom`, at no more than that entry's numbers, when that entry is gone or smaller here. The
 * field means nothing once the key exists on the base branch.
 */
export function checkBaselineAgainstBase(
  head: FunctionSizeBaseline,
  base: FunctionSizeBaseline,
): Violation[] {
  const violations: Violation[] = [];
  const report = (source: string, detail: string) =>
    violations.push({ kind: 'function-size', source, target: 'base branch baseline', detail });

  for (const key of Object.keys(head).sort()) {
    const entry = head[key];
    const onBase = entryOf(base, key);
    if (onBase) {
      if (isAbove(entry, onBase)) {
        report(
          key,
          `The baseline raises this from ${describeSize(onBase)} to ${describeSize(entry)}. ` +
            'Nothing here can raise a number; shrink the function, or the owner merges past this.',
        );
      }
      continue;
    }
    if (entry.movedFrom === undefined) {
      report(
        key,
        'The baseline gains this key. A new function must fit the limits; if it was extracted ' +
          'from a baselined function, say so with movedFrom.',
      );
      continue;
    }
    const source = entryOf(base, entry.movedFrom);
    if (!source) {
      report(key, `movedFrom names ${entry.movedFrom}, which the base branch does not list.`);
      continue;
    }
    if (isAbove(entry, source)) {
      report(
        key,
        `Has ${describeSize(entry)}, above the ${describeSize(source)} of ${entry.movedFrom}, ` +
          'the entry it says it moved from.',
      );
    }
    const left = entryOf(head, entry.movedFrom);
    if (left && left.codeLines >= source.codeLines && left.complexity >= source.complexity) {
      report(key, `movedFrom names ${entry.movedFrom}, which must be gone or smaller in this PR.`);
    }
  }
  return violations;
}

/** The whole baseline for a tree that has none yet. Only the file being absent leads here. */
export function generateBaseline(sizes: Map<string, FunctionSize>): FunctionSizeBaseline {
  const baseline: FunctionSizeBaseline = {};
  for (const [key, size] of sizes) if (isOverLimit(size)) baseline[key] = { ...size };
  return baseline;
}

/** Lowers numbers and removes entries. It never adds an entry or raises a number. */
export function lowerBaseline(
  baseline: FunctionSizeBaseline,
  sizes: Map<string, FunctionSize>,
): FunctionSizeBaseline {
  const lowered: FunctionSizeBaseline = {};
  for (const [key, entry] of Object.entries(baseline)) {
    const size = sizes.get(key);
    if (!size || !isOverLimit(size)) continue;
    lowered[key] = {
      ...entry,
      codeLines: Math.min(entry.codeLines, size.codeLines),
      complexity: Math.min(entry.complexity, size.complexity),
    };
  }
  return lowered;
}

/** One entry per line, sorted, so two PRs lowering different entries merge cleanly. */
export function serializeBaseline(baseline: FunctionSizeBaseline): string {
  const lines = Object.keys(baseline)
    .sort()
    .map((key) => {
      const { codeLines, complexity, movedFrom } = baseline[key];
      const moved = movedFrom === undefined ? '' : `, "movedFrom": ${JSON.stringify(movedFrom)}`;
      return `  ${JSON.stringify(key)}: { "codeLines": ${codeLines}, "complexity": ${complexity}${moved} }`;
    });
  return lines.length === 0 ? '{}\n' : `{\n${lines.join(',\n')}\n}\n`;
}

export function parseBaseline(text: string): FunctionSizeBaseline {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${BASELINE_REPO_PATH} must hold one object.`);
  }
  for (const [key, entry] of Object.entries(parsed)) {
    const { codeLines, complexity, movedFrom, ...rest } = (entry ?? {}) as Partial<BaselineEntry>;
    const valid =
      Number.isInteger(codeLines) &&
      Number.isInteger(complexity) &&
      (movedFrom === undefined || typeof movedFrom === 'string') &&
      Object.keys(rest).length === 0;
    if (!valid) throw new Error(`${BASELINE_REPO_PATH}: the entry for ${key} is malformed.`);
  }
  return parsed as FunctionSizeBaseline;
}

/**
 * The baseline at a git ref, or null when that ref has none yet, which is true only of the pull
 * request that adds it. A ref that does not resolve throws: it must never read as "nothing to
 * compare", or a bad fetch would turn rule 4 off.
 */
export function baselineAtRef(ref: string, repoRoot: string): FunctionSizeBaseline | null {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  try {
    git('cat-file', '-e', `${ref}:${BASELINE_REPO_PATH}`);
  } catch {
    return null;
  }
  return parseBaseline(git('show', `${ref}:${BASELINE_REPO_PATH}`));
}

function resolveImport(source: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(source), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function checkArchitecture(
  srcRoot: string,
  functionSizeBaseline: FunctionSizeBaseline = {},
): Violation[] {
  const root = resolve(srcRoot);
  const files = sourceFiles(root);
  const graph = new Map<string, string[]>();
  const reactImports = new Map<string, string[]>();
  const violations: Violation[] = [];

  if (existsSync(resolve(root, 'types.ts'))) {
    violations.push({
      kind: 'type-hub',
      source: 'types.ts',
      target: 'types/',
      detail: 'Domain types must live in src/types/*; the compatibility type hub is forbidden.',
    });
  }

  for (const file of files) {
    const sourceName = relative(root, file).replaceAll('\\', '/');
    const dependencies: string[] = [];
    const text = readFileSync(file, 'utf-8');
    if (CHILD_PROCESS_IMPORT_PATTERN.test(text) && SYNC_PROCESS_API_PATTERN.test(text)) {
      violations.push({
        kind: 'blocking-process',
        source: sourceName,
        target: 'child_process',
        detail: 'Production code must not use synchronous child-process APIs.',
      });
    }
    if (
      !PROCESS_LIFETIME_OWNERS.has(sourceName) &&
      !sourceName.startsWith('test/') &&
      callsProcessExit(text)
    ) {
      violations.push({
        kind: 'process-exit',
        source: sourceName,
        target: 'cli/exit.ts',
        detail: 'Process termination must go through the injectable exit() abstraction.',
      });
    }
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      if (!match[1] && REACT_SPECIFIER_PATTERN.test(match[2])) {
        reactImports.set(sourceName, [...(reactImports.get(sourceName) ?? []), match[2]]);
      }
      const dependency = resolveImport(file, match[2]);
      if (!dependency || !dependency.startsWith(root)) continue;
      const targetName = relative(root, dependency).replaceAll('\\', '/');
      if (match[1]) continue;
      dependencies.push(targetName);

      if (!sourceName.startsWith('tui/') && targetName.startsWith('tui/')) {
        violations.push({
          kind: 'layer',
          source: sourceName,
          target: targetName,
          detail: 'Non-TUI code must not import from tui/.',
        });
      }
      if (targetName === 'index.ts' || targetName === 'sdk.ts') {
        violations.push({
          kind: 'entrypoint',
          source: sourceName,
          target: targetName,
          detail: 'Implementation modules must not import CLI or SDK entry points.',
        });
      }
    }
    graph.set(sourceName, dependencies);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const reported = new Set<string>();
  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const members = new Set(cycle);
      const key = [...members].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        violations.push({
          kind: 'cycle',
          source: cycle[0] ?? node,
          target: node,
          detail: `Import cycle: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const file of graph.keys()) visit(file);

  // A TSX module imports react/jsx-runtime once compiled, so it counts as a React import too.
  const reached = new Set<string>();
  const pending = graph.has(CLI_ENTRY) ? [CLI_ENTRY] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (reached.has(node)) continue;
    reached.add(node);
    pending.push(...(graph.get(node) ?? []));
  }
  for (const node of [...reached].sort()) {
    const targets = [
      ...(node.endsWith('.tsx') ? ['react/jsx-runtime'] : []),
      ...(reactImports.get(node) ?? []),
    ];
    for (const target of targets) {
      violations.push({
        kind: 'eager-react',
        source: node,
        target,
        detail:
          'The CLI entry reaches React statically, so it loads before runtime-env.ts sets ' +
          'NODE_ENV and runs its development build. Load it with a dynamic import().',
      });
    }
  }

  violations.push(...checkFunctionSizes(measureFunctionSizes(root), functionSizeBaseline));
  return violations;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // Lowers numbers and removes entries. With no baseline file at all, it generates one.
      'update-baseline': { type: 'boolean', default: false },
      // Rule 4: compare the baseline with the one at this git ref. A pull request's CI passes this.
      'base-ref': { type: 'string' },
    },
  });
  const root = resolve(positionals[0] ?? 'src');
  const repoRoot = resolve(dirname(currentFile), '..');
  const baselinePath = resolve(repoRoot, BASELINE_REPO_PATH);
  const readBaseline = () =>
    existsSync(baselinePath) ? parseBaseline(readFileSync(baselinePath, 'utf-8')) : null;

  if (values['update-baseline']) {
    const sizes = measureFunctionSizes(root);
    const current = readBaseline();
    const next = current ? lowerBaseline(current, sizes) : generateBaseline(sizes);
    writeFileSync(baselinePath, serializeBaseline(next));
    console.log(`${BASELINE_REPO_PATH}: ${Object.keys(next).length} entries.`);
  }

  const baseline = readBaseline() ?? {};
  const violations = checkArchitecture(root, baseline);
  const baseRef = values['base-ref'];
  if (baseRef) {
    const base = baselineAtRef(baseRef, repoRoot);
    if (base) violations.push(...checkBaselineAgainstBase(baseline, base));
    else console.log(`${baseRef} has no ${BASELINE_REPO_PATH} yet, so nothing to compare with.`);
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `[${violation.kind}] ${violation.source} -> ${violation.target}: ${violation.detail}`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log('Architecture checks passed.');
  }
}
