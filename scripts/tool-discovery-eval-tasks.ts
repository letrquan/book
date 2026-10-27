import type { ToolCall } from '../src/types/tools.js';

/**
 * Tasks for `npm run eval:tools`, each needing exactly one deferred tool. Every answer is a
 * codename only its fixture holds, so a run that names it got there through a tool. Nothing here
 * needs the internet: pages come from the eval's own fixture server, and WebSearch and the session
 * history answer from fixtures (see `tool-discovery-eval-worker.ts`).
 */

export interface ToolEvalFixture {
  /** The fixture server's origin, `http://127.0.0.1:<port>`. */
  baseUrl: string;
}

/** A call a scripted model makes in mock mode. */
export interface ScriptedCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolEvalTask {
  name: string;
  /** The one deferred tool the task needs. */
  target: string;
  /** What a real run reaches beyond the provider and the local fixtures, when anything. */
  network?: string;
  prompt(fixture: ToolEvalFixture): string;
  /** Files the workspace starts with, committed as one commit after `commits`. */
  files?: Record<string, string>;
  /** Commits the workspace starts with, oldest first. */
  commits?: Array<{ message: string; files: Record<string, string> }>;
  /** Whether the run got the task right, from its final answer and the workspace's files. */
  verify(answer: string, readFile: (path: string) => string | null): boolean;
  /** Whether a call does the task another way: `curl` in Bash, a notebook rewritten by hand. */
  isFallback(call: ToolCall): boolean;
  /** How mock mode's scripted models do the task. */
  script: {
    /** Calls a scripted model sends with its first action, before anything else. */
    prelude?: ScriptedCall[];
    target(fixture: ToolEvalFixture): ScriptedCall;
    /** The capability query a searching model sends to ToolSearch. */
    searchQuery: string;
    /** The weak model's way around the tool. */
    fallback(fixture: ToolEvalFixture): ScriptedCall[];
  };
}

export const FETCH_CODENAME = 'ORCHID-7431';
export const SEARCH_CODENAME = 'HERON-2958';
export const GIT_CODENAME = 'KESTREL-5120';
export const NOTEBOOK_CODENAME = 'PLOVER-3307';
export const SESSION_CODENAME = 'WREN-8842';

/** What the fixture server answers, by path. `/search` stands in for a search engine. */
export const FIXTURE_PAGES: Record<string, string> = {
  '/release-notes.txt': [
    'Release 4.2.0',
    '',
    `This release is codenamed ${FETCH_CODENAME}. It adds streaming exports and fixes two`,
    'crashes in the importer.',
  ].join('\n'),
  '/search': `Lantern developer conference 2026: the keynote's codename is ${SEARCH_CODENAME}.`,
};

/** WebSearch's answer in every mode, whatever the query. */
export const FIXTURE_SEARCH_RESULTS = [
  '1. Lantern developer conference 2026 - keynote announced',
  '   https://lantern.example/2026/keynote',
  `   The organisers revealed the keynote's codename: ${SEARCH_CODENAME}.`,
  '2. Lantern 2025 recap',
  '   https://lantern.example/2025/recap',
  '   Talks, workshops and the hallway track from last year.',
].join('\n');

/** The session-history events SessionHistorySearch and SessionHistoryRead answer with. */
export const FIXTURE_SESSION_EVENTS = [
  {
    ref: 'session://current/event/fixture-12',
    role: 'user' as const,
    preview: `The staging cluster's codename is ${SESSION_CODENAME}; keep it out of commit messages.`,
  },
  {
    ref: 'session://current/event/fixture-13',
    role: 'assistant' as const,
    preview: 'Understood: I will keep the staging cluster codename out of commit messages.',
  },
];

const NOTEBOOK_CELLS = [
  { id: 'load', source: 'import json\nrows = json.load(open("rows.json"))' },
  { id: 'plot', source: 'print("draft")' },
];

export function notebookJson(cells: Array<{ id: string; source: string }>): string {
  return `${JSON.stringify(
    {
      cells: cells.map((cell) => ({
        cell_type: 'code',
        execution_count: null,
        id: cell.id,
        metadata: {},
        outputs: [],
        source: cell.source,
      })),
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
}

const pathOf = (call: ToolCall): string =>
  String(call.arguments.filePath ?? call.arguments.file_path ?? call.arguments.path ?? '');
const commandOf = (call: ToolCall): string =>
  call.name === 'Bash' ? String(call.arguments.command ?? '') : '';
const includes = (answer: string, codename: string): boolean => answer.includes(codename);

export const TOOL_EVAL_TASKS: readonly ToolEvalTask[] = [
  {
    name: 'fetch-url',
    target: 'WebFetch',
    prompt: ({ baseUrl }) =>
      `What codename does the release note at ${baseUrl}/release-notes.txt announce? Reply with the codename only.`,
    verify: (answer) => includes(answer, FETCH_CODENAME),
    isFallback: (call) => /\b(curl|wget)\b|https?:\/\//.test(commandOf(call)),
    script: {
      target: ({ baseUrl }) => ({
        name: 'WebFetch',
        arguments: { url: `${baseUrl}/release-notes.txt` },
      }),
      searchQuery: 'fetch web page url',
      fallback: ({ baseUrl }) => [
        { name: 'Bash', arguments: { command: `curl -s ${baseUrl}/release-notes.txt` } },
      ],
    },
  },
  {
    name: 'web-search',
    target: 'WebSearch',
    network:
      'none for WebSearch, which answers from a fixture; a real model falling back to curl reaches the internet',
    prompt: () =>
      'Search the web: what is the codename of the keynote at the 2026 Lantern developer conference? Reply with the codename only.',
    verify: (answer) => includes(answer, SEARCH_CODENAME),
    isFallback: (call) => /\b(curl|wget)\b|https?:\/\//.test(commandOf(call)),
    script: {
      target: () => ({
        name: 'WebSearch',
        arguments: { query: 'Lantern developer conference 2026 keynote codename' },
      }),
      searchQuery: 'web search',
      fallback: ({ baseUrl }) => [
        {
          name: 'Bash',
          arguments: { command: `curl -s "${baseUrl}/search?q=lantern+2026+keynote+codename"` },
        },
      ],
    },
  },
  {
    name: 'git-history',
    target: 'GitLog',
    prompt: () =>
      "Which commit in this repository's git history raised the retry limit? Reply with the ticket id in its message, only.",
    commits: [
      {
        message: 'Add the HTTP client',
        files: { 'src/client.js': 'export const retries = 3;\n' },
      },
      {
        message: `Raise the retry limit to 7 (${GIT_CODENAME})`,
        files: { 'src/client.js': 'export const retries = 7;\n' },
      },
      {
        message: 'Document the client',
        files: { 'README.md': '# client\n\nA small HTTP client.\n' },
      },
    ],
    verify: (answer) => includes(answer, GIT_CODENAME),
    isFallback: (call) =>
      /\bgit\s+(log|show|blame|rev-list|shortlog|reflog)\b/.test(commandOf(call)),
    script: {
      target: () => ({ name: 'GitLog', arguments: {} }),
      searchQuery: 'git commit history log',
      fallback: () => [{ name: 'Bash', arguments: { command: 'git log --oneline -n 20' } }],
    },
  },
  {
    name: 'notebook-edit',
    target: 'NotebookEdit',
    prompt: () =>
      `In analysis.ipynb, replace the source of the cell with id "plot" with: print("${NOTEBOOK_CODENAME}")`,
    files: { 'analysis.ipynb': notebookJson(NOTEBOOK_CELLS) },
    verify: (_answer, readFile) => {
      try {
        const notebook = JSON.parse(readFile('analysis.ipynb') ?? '') as {
          cells: Array<{ id?: string; source: string | string[] }>;
        };
        const source = (id: string) => {
          const cell = notebook.cells.find((candidate) => candidate.id === id);
          return cell ? [cell.source].flat().join('') : undefined;
        };
        return (
          notebook.cells.length === 2 &&
          source('plot') === `print("${NOTEBOOK_CODENAME}")` &&
          source('load') === NOTEBOOK_CELLS[0].source
        );
      } catch {
        return false;
      }
    },
    isFallback: (call) =>
      (['Write', 'Edit', 'MultiEdit', 'ApplyPatch'].includes(call.name) &&
        (pathOf(call).endsWith('.ipynb') ||
          String(call.arguments.patch ?? '').includes('.ipynb'))) ||
      commandOf(call).includes('.ipynb'),
    script: {
      // NotebookEdit, like Write, needs the file read first.
      prelude: [{ name: 'Read', arguments: { filePath: 'analysis.ipynb' } }],
      target: () => ({
        name: 'NotebookEdit',
        arguments: {
          notebook_path: 'analysis.ipynb',
          cell_id: 'plot',
          new_source: `print("${NOTEBOOK_CODENAME}")`,
        },
      }),
      searchQuery: 'edit jupyter notebook cell',
      fallback: () => [
        {
          name: 'Write',
          arguments: {
            filePath: 'analysis.ipynb',
            content: notebookJson([
              NOTEBOOK_CELLS[0],
              { id: 'plot', source: `print("${NOTEBOOK_CODENAME}")` },
            ]),
          },
        },
      ],
    },
  },
  {
    name: 'session-history',
    target: 'SessionHistorySearch',
    prompt: () =>
      "Earlier in this session, before the context was compacted, I told you the codename of the staging cluster. Find it in this session's history and reply with the codename only.",
    verify: (answer) => includes(answer, SESSION_CODENAME),
    // Looking through the workspace instead: it holds nothing from the conversation.
    isFallback: (call) => ['Bash', 'Grep', 'Glob'].includes(call.name),
    script: {
      target: () => ({
        name: 'SessionHistorySearch',
        arguments: { query: 'staging cluster codename' },
      }),
      searchQuery: 'past session conversation history',
      fallback: () => [{ name: 'Grep', arguments: { pattern: 'codename' } }],
    },
  },
];
