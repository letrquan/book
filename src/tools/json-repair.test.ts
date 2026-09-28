import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { repairToolArguments } from './json-repair.js';
import { validateToolArguments } from './schema.js';
import { createRegistry } from './registry.js';
import { toolSuccess } from './result.js';
import type { JsonSchemaObject, ToolContext } from '../types/tools.js';
import { afterEach, beforeEach } from 'vitest';

/**
 * The conservative repair contract (#242). Only three shapes qualify:
 * unescaped control characters inside strings (escape them), a trailing comma,
 * and missing closing `}`/`]` at the very end. A repair is accepted only when
 * the result parses as a JSON object AND validates against the tool's schema.
 * String content is never changed beyond escaping raw control characters, and
 * truncated values are never guessed.
 */

const EDIT: JsonSchemaObject = {
  type: 'object',
  properties: {
    filePath: { type: 'string' },
    oldString: { type: 'string' },
    newString: { type: 'string' },
  },
  required: ['filePath', 'oldString', 'newString'],
};
const BASH: JsonSchemaObject = {
  type: 'object',
  properties: { command: { type: 'string' }, timeout: { type: 'number' } },
  required: ['command'],
};
const TODOS: JsonSchemaObject = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { content: { type: 'string' }, status: { type: 'string' } },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
};
/** No required keys: any object validates. For cases that pin the JSON shape alone. */
const ANY: JsonSchemaObject = { type: 'object' };

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const backslash = String.fromCharCode(92);
/** An astral character: two UTF-16 code units but one code point. */
const EMOJI = '\u{1F600}';

interface CorpusCase {
  name: string;
  raw: string;
  schema: JsonSchemaObject;
  /** The exact arguments a repair must yield, or 'refuse' when none may run. */
  expect: Record<string, unknown> | 'refuse';
}

/**
 * The eval corpus: the malformed argument strings from the #242/#260 evidence,
 * plus synthetic coverage of each repairable and forbidden shape.
 */
const CORPUS: CorpusCase[] = [
  // ── Repairable: raw control characters inside strings ─────────────────────
  {
    name: 'literal tab inside a command',
    raw: `{"command":"echo one${TAB}echo two"}`,
    schema: BASH,
    expect: { command: `echo one${TAB}echo two` },
  },
  {
    name: 'literal newline inside a string',
    raw: `{"filePath":"a.ts","oldString":"x","newString":"line1${LF}line2"}`,
    schema: EDIT,
    expect: { filePath: 'a.ts', oldString: 'x', newString: 'line1\nline2' },
  },
  {
    name: 'literal CRLF inside a string',
    raw: '{"filePath":"a.ts","oldString":"x","newString":"a\r\nb"}',
    schema: EDIT,
    expect: { filePath: 'a.ts', oldString: 'x', newString: 'a\r\nb' },
  },
  {
    name: 'NUL inside a string escapes, it does not vanish',
    raw: `{"command":"echo a${NUL}b"}`,
    schema: BASH,
    expect: { command: `echo a${NUL}b` },
  },
  {
    // The #242 case: a large argument body (patch, regex, template) carrying
    // literal newlines inside a string.
    name: 'a patch body with literal newlines',
    raw: `{"patch":"*** Begin Patch${LF}*** Update File: a.ts${LF}@@${LF}-old${LF}+new${LF}*** End Patch"}`,
    schema: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
    expect: {
      patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch',
    },
  },

  // ── Repairable: a trailing comma ───────────────────────────────────────────
  {
    name: 'trailing comma before the closing brace',
    raw: `{"filePath":"a.ts","oldString":"x","newString":"y",}`,
    schema: EDIT,
    expect: { filePath: 'a.ts', oldString: 'x', newString: 'y' },
  },
  {
    name: 'trailing comma inside an array argument',
    raw: `{"todos":[{"content":"a","status":"pending"},]}`,
    schema: TODOS,
    expect: { todos: [{ content: 'a', status: 'pending' }] },
  },
  {
    name: 'trailing comma with whitespace before the closer',
    raw: `{"command": "ls -la",  \n}`,
    schema: BASH,
    expect: { command: 'ls -la' },
  },
  {
    // The drop index counts code units, so an astral character earlier in the text
    // must not shift the comma it points at: dropping by code point left the comma
    // in place and the repair never happened.
    name: 'trailing comma after an astral character in a value',
    raw: `{"command":"echo ${EMOJI}","a":1,}`,
    schema: ANY,
    expect: { command: `echo ${EMOJI}`, a: 1 },
  },
  {
    name: 'several dropped commas after an astral character',
    raw: `{"emoji":"${EMOJI}","a":[1,2,],"b":{"c":3,},}`,
    schema: ANY,
    expect: { emoji: EMOJI, a: [1, 2], b: { c: 3 } },
  },

  // ── Repairable: missing closing brace/bracket at the very end ─────────────
  {
    name: 'missing final brace',
    raw: `{"command":"ls"`,
    schema: BASH,
    expect: { command: 'ls' },
  },
  {
    name: 'missing final brace after a nested object',
    raw: `{"a":{"b":"c"`,
    schema: ANY,
    expect: { a: { b: 'c' } },
  },
  {
    name: 'missing bracket then brace',
    raw: `{"todos":[{"content":"a","status":"pending"}`,
    schema: TODOS,
    expect: { todos: [{ content: 'a', status: 'pending' }] },
  },
  {
    name: 'missing closers after a number',
    raw: `{"a":[1,2`,
    schema: ANY,
    expect: { a: [1, 2] },
  },
  {
    name: 'missing brace with trailing whitespace',
    raw: `{"command":"ls"   \n`,
    schema: BASH,
    expect: { command: 'ls' },
  },
  {
    name: 'control characters escaped and the final brace appended together',
    raw: `{"command":"echo${TAB}x"`,
    schema: BASH,
    expect: { command: `echo${TAB}x` },
  },
  {
    // ESC is a control character: it is escaped like any other, so the parsed
    // value keeps the literal byte.
    name: 'an escape sequence inside a string is escaped',
    raw: `{"command": "echo ${ESC}[0mhi"}`,
    schema: BASH,
    expect: { command: `echo ${ESC}[0mhi` },
  },

  // ── Refused: shapes that are never repaired ────────────────────────────────
  {
    // #260: the provider dropped the call's opening on the wire. Guessing the
    // missing `{"filePath": "` prefix would invent an argument the model sent.
    name: 'dropped opening fragment (#260) is never repaired',
    raw: '/tools/file.ts", "oldString": "a", "newString": "b"}',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    // Same wire loss, read by V8 as one complete object followed by more text.
    name: 'a nested array whose opening never arrived (#260)',
    raw: '{"content":"x","status":"pending"}, {"content":"y","status":"done"}]}',
    schema: TODOS,
    expect: 'refuse',
  },
  {
    name: 'an invalid escape is not a control character',
    raw: `{"filePath":"src/a.ts","oldString":"const re = /${backslash}d+/;","newString":"x"}`,
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'single-quoted keys',
    raw: "{'filePath': 'a'}",
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'two concatenated objects',
    raw: '{"filePath":"a"}{"oldString":"b"}',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    // `C:\` escapes the closing quote; the string is unterminated and there is
    // nothing to append — guessing a quote would change the path the model sent.
    name: 'a backslash that escapes the closing quote',
    raw: `{"command": "dir C:${backslash}"}`,
    schema: BASH,
    expect: 'refuse',
  },
  {
    name: 'a string left open at the end',
    raw: '{"command": "ls',
    schema: BASH,
    expect: 'refuse',
  },
  {
    name: 'ends on a comma (the rest never arrived)',
    raw: '{"filePath": "a.ts",',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'ends on a colon (the value never arrived)',
    raw: '{"filePath": "a.ts", "oldString":',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'text after a complete object',
    raw: '{"command": "ls"} extra words',
    schema: BASH,
    expect: 'refuse',
  },
  {
    name: 'an extra closing brace',
    raw: '{"command": "x"}}',
    schema: BASH,
    expect: 'refuse',
  },
  {
    name: 'a cut-off literal',
    raw: '{"a": tru}',
    schema: ANY,
    expect: 'refuse',
  },
  {
    // Parses once the comma goes, but a top-level array is not an arguments object.
    name: 'a top-level array with a trailing comma',
    raw: '[{"filePath": "a"},]',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'a doubled comma between pairs',
    raw: '{"a":1,,"b":2}',
    schema: ANY,
    expect: 'refuse',
  },
  {
    // Parses after appending `}`, but the schema wants newString too: a repair
    // that validates the JSON but not the tool would still invent a call.
    name: 'repairs to JSON the schema refuses',
    raw: '{"filePath": "a.ts", "oldString": "x"',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'repairs to a value of the wrong type',
    raw: '{"filePath": "a.ts", "oldString": "x", "newString": 1',
    schema: EDIT,
    expect: 'refuse',
  },
  {
    name: 'a missing comma between pairs',
    raw: '{"a": "x" "b": 1}',
    schema: ANY,
    expect: 'refuse',
  },
  {
    name: 'an unescaped quote inside a string',
    raw: '{"command": "echo "hi""}',
    schema: BASH,
    expect: 'refuse',
  },
  {
    name: 'a code fence around the object stays wrapped, not repaired',
    raw: '```json\n{"command":"ls"}\n```',
    schema: BASH,
    expect: 'refuse',
  },
];

describe('repairToolArguments', () => {
  it('returns undefined for text that already parses', () => {
    // A literal `__raw` argument whose text is valid JSON is the provider
    // sentinel carrying a whole object — not a failure to repair into one.
    expect(repairToolArguments('{"filePath":"a.ts"}')).toBeUndefined();
  });

  it('repairs each repairable case to exactly the intended arguments', () => {
    for (const c of CORPUS.filter((entry) => entry.expect !== 'refuse')) {
      const repaired = repairToolArguments(c.raw);
      expect(repaired, c.name).toEqual(c.expect);
    }
  });

  it('refuses each non-repairable shape', () => {
    // "Refused" is end-to-end: some shapes repair to JSON that only the schema
    // check rejects, so refusal means `repairToolArguments` declined OR the
    // candidate failed validation — the same predicate the eval counts.
    for (const c of CORPUS.filter((entry) => entry.expect === 'refuse')) {
      const repaired = repairToolArguments(c.raw);
      const accepted =
        repaired !== undefined && validateToolArguments(repaired, c.schema).length === 0;
      expect(accepted, c.name).toBe(false);
    }
  });

  it('eval: reports repaired-correctly / repaired-wrongly / refused against the corpus', () => {
    // The ship gate for repair (#242): a wrong repair silently changes an edit,
    // so the corpus tolerates refusals but no wrong repairs at all.
    let repairedCorrectly = 0;
    let repairedWrongly = 0;
    let refused = 0;
    const wrongly: string[] = [];
    // Key-order-insensitive comparison for the expected arguments object.
    const canon = (value: unknown): string =>
      JSON.stringify(value, (_key, val) =>
        val && typeof val === 'object' && !Array.isArray(val)
          ? Object.fromEntries(
              Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
            )
          : val,
      );
    for (const c of CORPUS) {
      const repaired = repairToolArguments(c.raw);
      const accepted =
        repaired !== undefined && validateToolArguments(repaired, c.schema).length === 0;
      if (!accepted) {
        refused++;
        continue;
      }
      if (c.expect !== 'refuse' && canon(repaired) === canon(c.expect)) {
        repairedCorrectly++;
      } else {
        repairedWrongly++;
        wrongly.push(c.name);
      }
    }
    console.log(
      `json-repair eval: ${repairedCorrectly} repaired-correctly, ` +
        `${repairedWrongly} repaired-wrongly, ${refused} refused (${CORPUS.length} cases)`,
    );
    expect(wrongly).toEqual([]);
  });
});

describe('registry executes a repaired call', () => {
  let dir: string;
  const ctx: ToolContext = { workspaceRoot: '', env: {} };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-repair-'));
    ctx.workspaceRoot = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function editLikeRegistry() {
    const execute = vi.fn(async () => toolSuccess('ok'));
    const registry = createRegistry();
    registry.register({
      name: 'Edit',
      description: 'edit a file',
      parameters: EDIT as Record<string, unknown>,
      execute,
    });
    return { registry, execute };
  }

  const malformed = `{"filePath":"a.ts","oldString":"x","newString":"line1${LF}line2"}`;

  it('runs the tool with the repaired arguments', async () => {
    const { registry, execute } = editLikeRegistry();

    const result = await registry.execute(
      {
        id: 'repair-1',
        name: 'Edit',
        arguments: {},
        unparsedArguments: { raw: malformed, error: 'Invalid control character' },
      },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(
      { filePath: 'a.ts', oldString: 'x', newString: 'line1\nline2' },
      expect.anything(),
    );
  });

  it('repairs a legacy {__raw} call the same way', async () => {
    const { registry, execute } = editLikeRegistry();

    const result = await registry.execute(
      { id: 'repair-2', name: 'Edit', arguments: { __raw: malformed } },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(execute).toHaveBeenCalledWith(
      { filePath: 'a.ts', oldString: 'x', newString: 'line1\nline2' },
      expect.anything(),
    );
  });

  it('drops the repair when the result parses but fails the schema', async () => {
    const { registry, execute } = editLikeRegistry();

    const result = await registry.execute(
      {
        id: 'repair-3',
        name: 'Edit',
        arguments: {},
        unparsedArguments: {
          raw: '{"filePath":"a.ts","oldString":"x"',
          error: 'Unexpected end of JSON input',
        },
      },
      ctx,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.structuredError?.code).toBe('invalid_json_arguments');
  });
});
