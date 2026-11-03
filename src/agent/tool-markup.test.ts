import { describe, expect, it } from 'vitest';
import { detectToolCallMarkup } from './tool-markup.js';

// The markers, as escapes: U+FF5C is the fullwidth vertical line and U+2581 the lower one-eighth
// block, and a tool that normalises text turns either into a lookalike without a word.
const BAR = '\uFF5C';
const LOW = '\u2581';

/** The scenario text of #667 as the issue wrote it. */
const ISSUE_DSML =
  '<｜DSML｜ calls>\n<｜DSML｜ invoke name="Grep">\n<｜DSML｜ parameter name="pattern" string="true">queue</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

const dsml = (tag: string) => `<${BAR}DSML${BAR}${tag}>`;
const dsmlEnd = (tag: string) => `</${BAR}DSML${BAR}${tag}>`;
const v3 = (name: string) => `<${BAR}${name.replaceAll(' ', LOW)}${BAR}>`;

const V3_BLOCK =
  v3('tool calls begin') +
  v3('tool call begin') +
  `function${v3('tool sep')}Grep\n` +
  '```json\n{"pattern": "queue"}\n```' +
  v3('tool call end') +
  v3('tool calls end');

const HERMES_BLOCK =
  '<tool_call>\n{"name": "Grep", "arguments": {"pattern": "queue"}}\n</tool_call>';

describe('detectToolCallMarkup', () => {
  it('uses the markers #667 shows, byte for byte', () => {
    expect(ISSUE_DSML.codePointAt(1)).toBe(0xff5c);
    expect(ISSUE_DSML.startsWith(`<${BAR}DSML${BAR} calls>`)).toBe(true);
    expect(detectToolCallMarkup(ISSUE_DSML)).toEqual({
      format: 'dsml',
      label: 'DeepSeek DSML',
      closed: true,
    });
  });

  describe('DSML', () => {
    it('reads the spelling without a space and with a function_ prefix', () => {
      const text = `${dsml('function_calls')}\n${dsml('invoke name="Read"')}\n${dsmlEnd('invoke')}\n${dsmlEnd('function_calls')}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: true });
    });

    it('reads a block after narration, and past trailing whitespace', () => {
      expect(
        detectToolCallMarkup(`Let me check the queue.\n\n${ISSUE_DSML}\n\n  \n`),
      ).toMatchObject({
        format: 'dsml',
        closed: true,
      });
    });

    it('reads a block whose outer closing tag was swallowed', () => {
      const text = `${dsml(' calls')}\n${dsml(' invoke name="Grep"')}\n${dsmlEnd(' invoke')}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: true });
    });

    it('reads a block cut off before any closing tag', () => {
      const text = `${dsml(' calls')}\n${dsml(' invoke name="Grep"')}\n${dsml(' parameter name="pattern"')}queue`;
      expect(detectToolCallMarkup(text)).toEqual({
        format: 'dsml',
        label: 'DeepSeek DSML',
        closed: false,
      });
    });

    it('reads a block cut off after its first parameter closed', () => {
      const text = `${dsml(' calls')}\n${dsml(' invoke name="Grep"')}\n${dsml(' parameter name="path"')}src${dsmlEnd(' parameter')}\n${dsml(' parameter name="pattern"')}que`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: false });
    });

    it('reads a bare opening tag at the end only on a line of its own', () => {
      expect(detectToolCallMarkup(`I will search.\n${dsml(' calls')}`)).toMatchObject({
        format: 'dsml',
        closed: false,
      });
      // Both of these end a sentence rather than a route's cut-off block.
      expect(detectToolCallMarkup(`The router leaks ${dsml(' calls')}`)).toBeNull();
      expect(detectToolCallMarkup(`- DeepSeek emits ${dsml('function_calls')}`)).toBeNull();
    });

    it('reads a cut-off block that starts after narration on the same line', () => {
      const text = `Let me check.${dsml(' calls')}\n${dsml(' invoke name="Grep"')}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: false });
    });

    it('reads a block followed by an end-of-turn token the route leaked', () => {
      const eos = `<${BAR}end${LOW}of${LOW}sentence${BAR}>`;
      for (const token of [eos, '<|im_end|>', '<|endoftext|>', '<|eot_id|>']) {
        expect(detectToolCallMarkup(`${ISSUE_DSML}${token}`), token).toMatchObject({
          format: 'dsml',
          closed: true,
        });
        expect(detectToolCallMarkup(`${ISSUE_DSML}\n${token}\n`), token).toMatchObject({
          format: 'dsml',
        });
      }
      expect(detectToolCallMarkup(`${V3_BLOCK}${eos}`)).toMatchObject({ format: 'deepseek' });
      expect(detectToolCallMarkup(`${HERMES_BLOCK}<|im_end|>`)).toMatchObject({ format: 'hermes' });
    });

    it('does not read an end-of-turn token after prose or after a fenced example', () => {
      expect(detectToolCallMarkup('The queue is FIFO.<|im_end|>')).toBeNull();
      expect(detectToolCallMarkup(`\`\`\`\n${ISSUE_DSML}\n\`\`\`<|im_end|>`)).toBeNull();
    });

    it('is not quadratic on a reply that repeats a tag, or a run of spaces, forever', () => {
      // A degenerate reply is a model's failure mode, not a reason to hang the loop. The five-second
      // limit is the assertion: each of these takes a few milliseconds.
      const spaces = ' '.repeat(200_000);
      const none = [
        `${BAR}DSML${BAR} `.repeat(50_000),
        `<${BAR}DSML${BAR} `.repeat(50_000),
        `</${BAR}DSML${BAR} `.repeat(50_000),
        '<tool_call>'.repeat(40_000),
        '\n<tool_call>'.repeat(40_000),
        `${spaces}x<|im_end|>`,
        `${spaces}<tool_call>\n{}\n</tool_call>`,
        '<|im_end|>'.repeat(50_000),
      ];
      for (const text of none) expect(detectToolCallMarkup(text)).toBeNull();
      expect(detectToolCallMarkup(dsml(' calls').repeat(30_000))).toMatchObject({ format: 'dsml' });
    }, 5_000);

    it('reads the ASCII bar a re-encoding route leaves behind', () => {
      expect(
        detectToolCallMarkup('<|DSML|function_calls>\n<|DSML|invoke name="x">\n</|DSML|invoke>'),
      ).toMatchObject({ format: 'dsml' });
    });

    it('does not read prose that follows an opening tag', () => {
      expect(detectToolCallMarkup(`The router leaks ${dsml(' calls')} as text.`)).toBeNull();
    });

    it('does not read a closed block that prose follows', () => {
      expect(detectToolCallMarkup(`${ISSUE_DSML}\n\nThat is the call I would make.`)).toBeNull();
    });

    it('does not read a block cut off before prose that follows its last closing tag', () => {
      const text = `${dsml(' calls')}\n${dsml(' invoke name="a"')}\n${dsmlEnd(' invoke')}\nDone. That was the call.`;
      expect(detectToolCallMarkup(text)).toBeNull();
    });
  });

  describe('DeepSeek V3 tokens', () => {
    it('reads a whole block, JSON fence and all', () => {
      expect(detectToolCallMarkup(V3_BLOCK)).toEqual({
        format: 'deepseek',
        label: 'DeepSeek tool-call tokens',
        closed: true,
      });
    });

    it('reads a block straight after the narration on the same line', () => {
      expect(detectToolCallMarkup(`Let me check.${V3_BLOCK}`)).toMatchObject({
        format: 'deepseek',
      });
    });

    it('reads a block cut off inside its JSON', () => {
      const text = `${v3('tool calls begin')}${v3('tool call begin')}function${v3('tool sep')}Grep\n\`\`\`json\n{"pattern": "que`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'deepseek', closed: false });
    });

    it('reads the ASCII spelling', () => {
      expect(
        detectToolCallMarkup(
          '<|tool_calls_begin|><|tool_call_begin|>x<|tool_call_end|><|tool_calls_end|>',
        ),
      ).toMatchObject({ format: 'deepseek', closed: true });
    });
  });

  describe('Hermes and Qwen <tool_call>', () => {
    it('reads a JSON block', () => {
      expect(detectToolCallMarkup(HERMES_BLOCK)).toEqual({
        format: 'hermes',
        label: '<tool_call> tags',
        closed: true,
      });
    });

    it('reads Qwen3-Coder function blocks after narration, with several calls', () => {
      const text =
        'I will read both.\n<tool_call>\n<function=Read>\n<parameter=file_path>\na.ts\n</parameter>\n</function>\n</tool_call>\n' +
        '<tool_call>\n<function=Read>\n<parameter=file_path>\nb.ts\n</parameter>\n</function>\n</tool_call>\n';
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'hermes', closed: true });
    });

    it('reads a block that follows narration on the same line, with its content on the next', () => {
      expect(
        detectToolCallMarkup(
          'Let me check.<tool_call>\n{"name": "Grep", "arguments": {}}\n</tool_call>',
        ),
      ).toMatchObject({ format: 'hermes', closed: true });
      expect(detectToolCallMarkup('Let me check <tool_call>\r\n{}\r\n</tool_call>')).toMatchObject({
        format: 'hermes',
      });
    });

    it('does not read a pair written inline in a sentence, or an indented one', () => {
      expect(detectToolCallMarkup('Qwen emits <tool_call>{"name": "x"}</tool_call>')).toBeNull();
      expect(detectToolCallMarkup('See:\n  <tool_call>\n  {}\n  </tool_call>')).toBeNull();
      expect(detectToolCallMarkup('See:\n\t<tool_call>\n{}\n</tool_call>')).toBeNull();
    });

    it('does not read a block that was never closed', () => {
      expect(detectToolCallMarkup('<tool_call>\n{"name": "Grep", "arguments": {"pat')).toBeNull();
      expect(detectToolCallMarkup('Qwen starts a call with\n<tool_call>')).toBeNull();
    });

    it('does not read <tool_calls> or a tag with a suffix', () => {
      expect(detectToolCallMarkup('<tool_calls>\n[]\n</tool_calls>')).toBeNull();
    });
  });

  describe('replies that are answers', () => {
    it.each([
      ['an empty reply', ''],
      ['only whitespace', ' \n\t '],
      ['plain prose', 'The queue is drained in FIFO order by the worker.'],
      [
        'a tag named in inline code mid-answer',
        'Qwen wraps each call in `<tool_call>` and `</tool_call>`, which Book does not parse.\n\nConfigure the parser instead.',
      ],
      [
        'a tag named in prose, with the example at the start of a line and prose after it',
        `Qwen emits\n${HERMES_BLOCK}\nwhen its parser is off, and Book leaves that alone.`,
      ],
      [
        'a tag named in prose that ends in a sentence',
        'To see a call, look for <tool_call> in the raw output, then </tool_call> after the JSON.',
      ],
      [
        'a closed fence showing the format',
        `The raw output looks like this:\n\n\`\`\`xml\n${HERMES_BLOCK}\n\`\`\``,
      ],
      [
        'a tilde fence showing the format',
        `The raw output looks like this:\n\n~~~\n${ISSUE_DSML}\n~~~`,
      ],
      [
        'a fence that was never closed around a full block',
        `The raw output looks like this:\n\n\`\`\`xml\n${HERMES_BLOCK}\n`,
      ],
      [
        'a DSML example in a fence that was never closed',
        `Here is what the router sent:\n\`\`\`\n${ISSUE_DSML}`,
      ],
      [
        'a V3 example in a four-backtick fence that was never closed',
        `Raw:\n\`\`\`\`\n${V3_BLOCK}`,
      ],
      ['an indented example', `Qwen emits:\n\n    <tool_call>\n    {}\n    </tool_call>`],
      [
        'the format named at the end in backticks',
        `The route leaked \`${dsml(' calls')}\` and \`${dsmlEnd(' calls')}\``,
      ],
    ])('does not read %s', (_name, text) => {
      expect(detectToolCallMarkup(text)).toBeNull();
    });

    it('reads a real block after a fence that was closed', () => {
      const text = `Example:\n\`\`\`\nfoo\n\`\`\`\n\n${HERMES_BLOCK}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'hermes' });
    });

    it('reads a DSML block that holds a code fence of its own', () => {
      const text = `${dsml(' calls')}\n${dsml(' invoke name="Write"')}\n${dsml(' parameter name="content" string="true"')}# Title\n\`\`\`js\nfoo();\n\`\`\`\n${dsmlEnd(' parameter')}\n${dsmlEnd(' invoke')}\n${dsmlEnd(' calls')}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: true });
    });

    it('reads a block that follows a fenced example of the same format', () => {
      const text = `The router sent:\n\`\`\`\n${ISSUE_DSML}\n\`\`\`\nand now it sends:\n${ISSUE_DSML}`;
      expect(detectToolCallMarkup(text)).toMatchObject({ format: 'dsml', closed: true });
    });
  });
});
