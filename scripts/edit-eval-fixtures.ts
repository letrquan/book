/**
 * Deterministic edit-reliability fixtures. Each task seeds a small workspace,
 * gives the model one explicit editing instruction, and verifies the resulting
 * file contents with plain string predicates — no LLM judging. The corpus
 * exercises edit MECHANICS (exact matching, whitespace, encodings, multi-file
 * changes), not problem solving, so instructions stay deliberately simple.
 */

export interface EvalTask {
  name: string;
  category: string;
  files: Record<string, string>;
  instruction: string;
  /** Files verify() reads that are not seeded (created by the task). */
  createdFiles?: string[];
  verify: (read: (path: string) => string | null) => boolean;
}

const CRLF = '\r\n';

export const EVAL_TASKS: EvalTask[] = [
  {
    name: 'exact-replace-simple',
    category: 'exact',
    files: { 'config.ts': 'export const RETRY_LIMIT = 3;\nexport const TIMEOUT_MS = 5000;\n' },
    instruction: 'In config.ts, change RETRY_LIMIT from 3 to 5. Change nothing else.',
    verify: (read) => {
      const text = read('config.ts');
      return !!text && text.includes('RETRY_LIMIT = 5') && text.includes('TIMEOUT_MS = 5000');
    },
  },
  {
    name: 'exact-replace-multiline',
    category: 'exact',
    files: {
      'math.ts':
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n',
    },
    instruction:
      'In math.ts, change the add function to return a + b + 0 (keep the same signature). Change nothing else.',
    verify: (read) => {
      const text = read('math.ts');
      return !!text && text.includes('return a + b + 0;') && text.includes('return a - b;');
    },
  },
  {
    name: 'replace-all-rename',
    category: 'multi-site',
    files: {
      'user.ts':
        'export function getUser(id: string) {\n  return db.getUser(id);\n}\nexport function listUser() {\n  return db.listUser();\n}\n',
    },
    instruction: 'In user.ts, rename every occurrence of listUser to listUsers.',
    verify: (read) => {
      const text = read('user.ts');
      return (
        !!text &&
        !/listUser\(/.test(text) &&
        text.includes('listUsers()') &&
        text.includes('db.listUsers()') &&
        text.includes('getUser(id)')
      );
    },
  },
  {
    name: 'unique-context-disambiguation',
    category: 'multi-site',
    files: {
      'handlers.ts':
        'export function onOpen() {\n  log("event");\n}\n\nexport function onClose() {\n  log("event");\n}\n',
    },
    instruction:
      'In handlers.ts, change the log call inside onClose (only that one) to log("closed").',
    verify: (read) => {
      const text = read('handlers.ts');
      return (
        !!text && text.includes('onOpen() {\n  log("event");') && text.includes('log("closed")')
      );
    },
  },
  {
    name: 'trailing-whitespace-target',
    category: 'whitespace',
    files: { 'notes.ts': 'const first = 1;   \nconst second = 2;\t\nconst third = 3;\n' },
    instruction: 'In notes.ts, change second from 2 to 22. Change nothing else.',
    verify: (read) => {
      const text = read('notes.ts');
      return !!text && text.includes('second = 22') && text.includes('first = 1');
    },
  },
  {
    name: 'tab-indented-file',
    category: 'whitespace',
    files: {
      'tabs.ts': 'function run() {\n\tif (ready) {\n\t\tstart();\n\t}\n}\n',
    },
    instruction: 'In tabs.ts, change start() to startNow(). Keep the tab indentation.',
    verify: (read) => {
      const text = read('tabs.ts');
      return !!text && text.includes('\t\tstartNow();');
    },
  },
  {
    name: 'deep-indentation',
    category: 'whitespace',
    files: {
      'deep.ts':
        'a(() => {\n  b(() => {\n    c(() => {\n      d(() => {\n        e(() => {\n          target();\n        });\n      });\n    });\n  });\n});\n',
    },
    instruction: 'In deep.ts, change target() to hit(). Keep the indentation as it is.',
    verify: (read) => {
      const text = read('deep.ts');
      return !!text && text.includes('          hit();');
    },
  },
  {
    name: 'crlf-line-endings',
    category: 'encoding',
    files: {
      'windows.ts': `const alpha = 'a';${CRLF}const beta = 'b';${CRLF}const gamma = 'c';${CRLF}`,
    },
    instruction: "In windows.ts, change beta from 'b' to 'bee'. Change nothing else.",
    verify: (read) => {
      const text = read('windows.ts');
      return !!text && text.includes(`beta = 'bee'`) && text.includes(CRLF);
    },
  },
  {
    name: 'bom-preservation',
    category: 'encoding',
    files: { 'bom.ts': '﻿export const flag = false;\n' },
    instruction: 'In bom.ts, change flag from false to true.',
    verify: (read) => {
      const text = read('bom.ts');
      return !!text && text.includes('flag = true') && text.startsWith('﻿');
    },
  },
  {
    name: 'unicode-content',
    category: 'encoding',
    files: { 'i18n.ts': "export const greeting = 'Xin chào thế giới';\n" },
    instruction: "In i18n.ts, change the greeting string to 'Chào bạn'. Keep the quotes style.",
    verify: (read) => {
      const text = read('i18n.ts');
      return !!text && text.includes('Chào bạn') && !text.includes('thế giới');
    },
  },
  {
    name: 'long-line-edit',
    category: 'exact',
    files: {
      'long.ts': `export const wide = [${Array.from({ length: 120 }, (_, i) => `'item-${i}'`).join(', ')}];\n`,
    },
    instruction: "In long.ts, change 'item-57' to 'item-fifty-seven'. Change nothing else.",
    verify: (read) => {
      const text = read('long.ts');
      return (
        !!text &&
        text.includes(`'item-fifty-seven'`) &&
        text.includes(`'item-56', 'item-fifty-seven', 'item-58'`)
      );
    },
  },
  {
    name: 'multi-file-constant',
    category: 'multi-file',
    files: {
      'a.ts': "import { VERSION } from './version.js';\nexport const bannerA = `A ${VERSION}`;\n",
      'version.ts': "export const VERSION = '1.0.0';\n",
    },
    instruction: "Update VERSION in version.ts to '1.1.0' and bannerA in a.ts to `A2 ${VERSION}`.",
    verify: (read) => {
      const version = read('version.ts');
      const a = read('a.ts');
      return !!version && !!a && version.includes("'1.1.0'") && a.includes('`A2 ${VERSION}`');
    },
  },
  {
    name: 'new-file-creation',
    category: 'create',
    files: { 'index.ts': "export * from './core.js';\n" },
    createdFiles: ['util.ts'],
    instruction:
      "Create a new file util.ts that exports exactly one function: export function twice(n: number): number { return n * 2; } — then add export * from './util.js'; to index.ts.",
    verify: (read) => {
      const util = read('util.ts');
      const index = read('index.ts');
      return !!util && !!index && util.includes('return n * 2;') && index.includes("./util.js'");
    },
  },
  {
    name: 'delete-function',
    category: 'delete',
    files: {
      'legacy.ts':
        'export function keep() {\n  return 1;\n}\n\nexport function removeMe() {\n  return 2;\n}\n',
    },
    instruction: 'In legacy.ts, delete the removeMe function entirely. Keep keep() unchanged.',
    verify: (read) => {
      const text = read('legacy.ts');
      return !!text && !text.includes('removeMe') && text.includes('function keep()');
    },
  },
  {
    name: 'line-number-prefix-trap',
    category: 'trap',
    files: { 'trap.ts': 'const one = 1;\nconst two = 2;\nconst three = 3;\n' },
    instruction:
      'A file viewer shows trap.ts as:\n1: const one = 1;\n2: const two = 2;\n3: const three = 3;\nChange line 2 so two equals 22. Remember the "N: " prefixes are viewer artifacts, not file content.',
    verify: (read) => {
      const text = read('trap.ts');
      return !!text && text.includes('two = 22') && !text.includes('2: const');
    },
  },
  {
    name: 'regex-special-characters',
    category: 'escaping',
    files: {
      'pattern.ts': 'export const RE = /^\\$\\{[a-z]+\\}$/;\nexport const COST = "$100";\n',
    },
    instruction: 'In pattern.ts, change COST from "$100" to "$250". Change nothing else.',
    verify: (read) => {
      const text = read('pattern.ts');
      return !!text && text.includes('"$250"') && text.includes('/^\\$\\{[a-z]+\\}$/');
    },
  },
  {
    name: 'json-escaped-strings',
    category: 'escaping',
    files: {
      'data.json':
        '{\n  "message": "Line one\\nLine two",\n  "path": "C:\\\\Users\\\\dev",\n  "count": 1\n}\n',
    },
    instruction: 'In data.json, change "count" from 1 to 2. Keep every other value identical.',
    verify: (read) => {
      const text = read('data.json');
      if (!text) return false;
      try {
        const parsed = JSON.parse(text) as { message: string; path: string; count: number };
        return (
          parsed.count === 2 &&
          parsed.message === 'Line one\nLine two' &&
          parsed.path === 'C:\\Users\\dev'
        );
      } catch {
        return false;
      }
    },
  },
  {
    name: 'markdown-section',
    category: 'docs',
    files: {
      'README.md': '# Tool\n\n## Install\n\nRun `npm install`.\n\n## Usage\n\nRun `tool start`.\n',
    },
    instruction:
      'In README.md, change the Usage section command from `tool start` to `tool run --fast`.',
    verify: (read) => {
      const text = read('README.md');
      return !!text && text.includes('`tool run --fast`') && text.includes('`npm install`');
    },
  },
  {
    name: 'import-and-use',
    category: 'multi-site',
    files: {
      'service.ts':
        "import { log } from './log.js';\n\nexport function handle(input: string) {\n  log(input);\n  return input.length;\n}\n",
    },
    instruction:
      "In service.ts, also import { warn } from './log.js' (same import statement) and call warn(input) immediately after the existing log(input) call.",
    verify: (read) => {
      const text = read('service.ts');
      return (
        !!text &&
        /import \{[^}]*log[^}]*warn[^}]*\}|import \{[^}]*warn[^}]*log[^}]*\}/.test(text) &&
        text.includes('warn(input)')
      );
    },
  },
  {
    name: 'signature-and-callsite',
    category: 'multi-file',
    files: {
      'greet.ts': "export function greet(name: string) {\n  return 'hi ' + name;\n}\n",
      'main.ts': "import { greet } from './greet.js';\nconsole.log(greet('sam'));\n",
    },
    instruction:
      "Add a second parameter excited: boolean to greet (append '!' to the result when true), and update the call in main.ts to greet('sam', true).",
    verify: (read) => {
      const greet = read('greet.ts');
      const main = read('main.ts');
      return !!greet && !!main && greet.includes('excited') && main.includes("greet('sam', true)");
    },
  },
  {
    name: 'comment-preservation',
    category: 'exact',
    files: {
      'limits.ts':
        '// Raising this past 10 requires a load test (see docs/perf.md).\nexport const MAX_WORKERS = 4;\n',
    },
    instruction: 'In limits.ts, change MAX_WORKERS from 4 to 8. Keep the comment exactly as is.',
    verify: (read) => {
      const text = read('limits.ts');
      return (
        !!text &&
        text.includes('MAX_WORKERS = 8') &&
        text.includes('// Raising this past 10 requires a load test (see docs/perf.md).')
      );
    },
  },
  {
    name: 'python-indentation',
    category: 'whitespace',
    files: {
      'app.py':
        'def main():\n    items = load()\n    for item in items:\n        if item.ok:\n            process(item)\n',
    },
    instruction: 'In app.py, change process(item) to handle(item). Keep the indentation valid.',
    verify: (read) => {
      const text = read('app.py');
      return !!text && text.includes('            handle(item)');
    },
  },
  {
    name: 'block-with-blank-lines',
    category: 'whitespace',
    files: {
      'setup.ts': 'init();\n\nconfigure({\n  mode: "fast",\n\n  retries: 2,\n});\n\nstart();\n',
    },
    instruction: 'In setup.ts, change retries from 2 to 4 inside the configure block.',
    verify: (read) => {
      const text = read('setup.ts');
      return !!text && text.includes('retries: 4') && text.includes('mode: "fast"');
    },
  },
  {
    name: 'triple-rename-one-file',
    category: 'multi-site',
    files: {
      'counter.ts': 'let cnt = 0;\nexport function bump() {\n  cnt += 1;\n  return cnt;\n}\n',
    },
    instruction: 'In counter.ts, rename cnt to count everywhere (3 occurrences).',
    verify: (read) => {
      const text = read('counter.ts');
      return !!text && !/\bcnt\b/.test(text) && (text.match(/\bcount\b/g)?.length ?? 0) >= 3;
    },
  },
  {
    name: 'similar-lines-adjacent',
    category: 'multi-site',
    files: {
      'routes.ts':
        "router.get('/a', handlerA);\nrouter.get('/b', handlerB);\nrouter.get('/c', handlerC);\n",
    },
    instruction: "In routes.ts, change only the '/b' route to use handlerB2.",
    verify: (read) => {
      const text = read('routes.ts');
      return (
        !!text &&
        text.includes("router.get('/b', handlerB2);") &&
        text.includes("router.get('/a', handlerA);") &&
        text.includes("router.get('/c', handlerC);")
      );
    },
  },
];
