import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

interface Violation {
  kind: 'layer' | 'entrypoint' | 'cycle';
  source: string;
  target: string;
  detail: string;
}

const IMPORT_PATTERN = /(?:import|export)\s+(type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const ALLOWED_CYCLE_MEMBERS = new Set([
  'agent/loop.ts',
  'agents/capabilities.ts',
  'agents/manager.ts',
  'tools/registry.ts',
  'tools/task-tool.ts',
  'tools/agent-tools.ts',
]);

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
  const violations: Violation[] = [];

  for (const file of files) {
    const sourceName = relative(root, file).replaceAll('\\', '/');
    const dependencies: string[] = [];
    const text = readFileSync(file, 'utf-8');
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      if (match[1]) continue;
      const dependency = resolveImport(file, match[2]);
      if (!dependency || !dependency.startsWith(root)) continue;
      const targetName = relative(root, dependency).replaceAll('\\', '/');
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
      const allowed =
        members.has('agents/manager.ts') &&
        members.has('tools/registry.ts') &&
        [...members].every((member) => ALLOWED_CYCLE_MEMBERS.has(member));
      const key = [...members].sort().join('|');
      if (!allowed && !reported.has(key)) {
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

  return violations;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const root = resolve(process.argv[2] ?? 'src');
  const violations = checkArchitecture(root);
  console.log('Temporary cycle exception: registry/agent-manager/task composition');
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
