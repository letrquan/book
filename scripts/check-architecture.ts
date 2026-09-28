import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

interface Violation {
  kind:
    | 'layer'
    | 'entrypoint'
    | 'cycle'
    | 'type-hub'
    | 'blocking-process'
    | 'process-exit'
    | 'eager-react';
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

function resolveImport(source: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(source), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function checkArchitecture(srcRoot: string): Violation[] {
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

  return violations;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(process.argv[2] ?? 'src');
  const violations = checkArchitecture(root);
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
