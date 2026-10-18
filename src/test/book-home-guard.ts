import ts from 'typescript';

/**
 * Static analysis behind the BOOK_HOME guard in `isolated-book-home.test.ts`: a suite that drives
 * the print-mode runner must have BOOK_HOME pinned wherever it does (#421). Parsed with the
 * TypeScript compiler, not matched with regular expressions, so a comment, a string such as
 * `'src/**\/*.ts'`, or a regex literal can neither hide a drive point nor fake a pin.
 *
 * What it knows, and where it approximates:
 * - A drive point is a call of `runHeadless` / `runMainAction`, a call of anything imported from an
 *   `sdk.js` module (a name, the default, or a member of a namespace import), or a dynamic
 *   `import('…sdk.js')` expression.
 * - A pin is `isolateBookHome(…)`, `enterIsolatedHome(…)`, an assignment to `process.env.BOOK_HOME`,
 *   `vi.stubEnv('BOOK_HOME', …)` or `stashEnv('BOOK_HOME', …)`. A restore is never one: anything
 *   inside an `afterEach` / `afterAll` callback or a `finally` block, or an assignment of a value
 *   previously read from `process.env.BOOK_HOME`.
 * - A pin covers the drive points in the narrowest scope it sits in: the rest of its `it` / `test`
 *   callback, else the `describe` that holds it (a hook in that describe included), else the whole
 *   file. APPROXIMATION: a pin inside a named helper function counts for the whole file, since
 *   which tests call the helper is not decided statically.
 */

type Role = 'describe' | 'it' | 'before' | 'after' | 'helper' | 'other';

const ROLE_BY_NAME: Record<string, Role> = {
  describe: 'describe',
  suite: 'describe',
  it: 'it',
  test: 'it',
  beforeEach: 'before',
  beforeAll: 'before',
  afterEach: 'after',
  afterAll: 'after',
};

const RUNNER_NAMES = new Set(['runHeadless', 'runMainAction']);
const SDK_MODULE = /(?:^|\/)sdk\.js$/;

/** The identifier a callee starts from: `it.each([…])` and `describe.skip` both give their root. */
function calleeRoot(expression: ts.Expression): string | undefined {
  let current: ts.Expression = expression;
  for (;;) {
    if (
      ts.isCallExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    } else {
      break;
    }
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function roleOf(fn: ts.Node): Role {
  const parent = fn.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(fn as ts.Expression)) {
    const name = calleeRoot(parent.expression);
    return (name && ROLE_BY_NAME[name]) || 'other';
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) return 'helper';
  if (ts.isVariableDeclaration(parent) && parent.initializer === fn) return 'helper';
  return 'other';
}

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

/** `process.env.BOOK_HOME` or `process.env['BOOK_HOME']`. */
function isBookHomeVariable(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'BOOK_HOME' && isProcessEnv(node.expression);
  }
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'BOOK_HOME' &&
    isProcessEnv(node.expression)
  );
}

function firstArgumentIsBookHome(call: ts.CallExpression): boolean {
  const [first] = call.arguments;
  return first !== undefined && ts.isStringLiteralLike(first) && first.text === 'BOOK_HOME';
}

function forEachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

/** Names that hold a value read from `process.env.BOOK_HOME`: what a restore puts back. */
function savedHomeNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  forEachNode(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isBookHomeVariable(node.initializer)
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isBookHomeVariable(node.right)
    ) {
      names.add(node.left.text);
    }
  });
  return names;
}

/** Names bound by imports from an `sdk.js` module, and the namespace imports among them. */
function sdkImports(file: ts.SourceFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }
    const clause = statement.importClause;
    if (!SDK_MODULE.test(statement.moduleSpecifier.text) || !clause || clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return { names, namespaces };
}

function driveRoot(callee: ts.Expression): string | undefined {
  let current = callee;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : undefined;
}

function driveNodes(file: ts.SourceFile): ts.Node[] {
  const { names, namespaces } = sdkImports(file);
  const found: ts.Node[] = [];
  forEachNode(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteralLike(specifier) && SDK_MODULE.test(specifier.text)) {
        found.push(node);
      }
      return;
    }
    const called = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    const root = driveRoot(callee);
    if (
      (ts.isIdentifier(callee) && (RUNNER_NAMES.has(callee.text) || names.has(callee.text))) ||
      (called !== undefined && RUNNER_NAMES.has(called)) ||
      (root !== undefined && ts.isPropertyAccessExpression(callee) && namespaces.has(root))
    ) {
      found.push(node);
    }
  });
  return found;
}

/** The part of the file a pin holds for: a node that must contain the drive point it covers. */
interface Cover {
  scope: ts.Node;
  /** Only drive points starting after this position (a pin inside one `it`). */
  after?: number;
}

/** Where a pin holds, or undefined when it is a restore rather than a pin. */
function coverOf(pin: ts.Node, file: ts.SourceFile): Cover | undefined {
  for (let node: ts.Node = pin; node.parent; node = node.parent) {
    const parent = node.parent;
    if (ts.isTryStatement(parent) && parent.finallyBlock === node) return undefined;
    if (!ts.isFunctionLike(node)) continue;
    const role = roleOf(node);
    if (role === 'after') return undefined;
    if (role === 'helper') return { scope: file };
    if (role === 'it') return { scope: node, after: pin.getStart(file) };
    if (role === 'describe') return { scope: node };
    // `before` hooks and anonymous callbacks take the scope of what holds them.
  }
  return { scope: file };
}

function pinNodes(file: ts.SourceFile): ts.Node[] {
  const saved = savedHomeNames(file);
  const found: ts.Node[] = [];
  forEachNode(file, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isIdentifier(callee) &&
        (callee.text === 'isolateBookHome' || callee.text === 'enterIsolatedHome')
      ) {
        found.push(node);
      }
      const stubs =
        (ts.isIdentifier(callee) && callee.text === 'stashEnv') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'stubEnv');
      if (stubs && firstArgumentIsBookHome(node)) found.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isBookHomeVariable(node.left) &&
      !(ts.isIdentifier(node.right) && saved.has(node.right.text))
    ) {
      found.push(node);
    }
  });
  return found;
}

/**
 * The 1-based lines of every drive point in `source` that no pin covers. Empty for a suite that
 * never drives the runner.
 */
export function unpinnedDriveLines(source: string, fileName = 'suite.test.ts'): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const covers = pinNodes(file)
    .map((pin) => coverOf(pin, file))
    .filter((cover): cover is Cover => cover !== undefined);
  return driveNodes(file)
    .filter((drive) => {
      const start = drive.getStart(file);
      return !covers.some(
        (cover) =>
          cover.scope.getStart(file) <= start &&
          drive.getEnd() <= cover.scope.getEnd() &&
          (cover.after === undefined || start > cover.after),
      );
    })
    .map((drive) => file.getLineAndCharacterOfPosition(drive.getStart(file)).line + 1);
}
