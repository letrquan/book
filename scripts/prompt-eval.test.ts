import { describe, expect, it } from 'vitest';
import type { ProviderMessage } from '../src/types/providers.js';
import {
  addVerifyCandidateLine,
  dropAllReasoning,
  echoesReplayTag,
  finalAnswerLeaksTag,
  fisherExact,
  inlinesThinkTag,
  gradeProbe,
  keepCurrentTurnReasoning,
  parseArgs,
  ranTests,
  removeVerifyCandidateLine,
  REPLAY_PROBES,
  reportsFailure,
  reportsGreen,
  VERIFY_CANDIDATE_LINE,
  VERIFY_KERNEL_LINE,
  wilson,
  writesReasoningTag,
} from './prompt-eval.js';

function system(prefix: string): ProviderMessage {
  return { role: 'system', content: { cachedPrefix: prefix, dynamicSuffix: '' } };
}

function prefixOf(messages: ProviderMessage[]): string {
  const content = messages[0]!.content as { cachedPrefix: string };
  return content.cachedPrefix;
}

describe('prompt-eval arms', () => {
  it('adds the verify candidate line right after the kernel line', () => {
    const out = addVerifyCandidateLine([system(`a\n${VERIFY_KERNEL_LINE}\nb`)]);
    expect(prefixOf(out)).toBe(`a\n${VERIFY_KERNEL_LINE}\n${VERIFY_CANDIDATE_LINE}\nb`);
  });

  it('refuses to measure a prompt that lost the kernel line', () => {
    expect(() => addVerifyCandidateLine([system('no line here')])).toThrow(/kernel line/);
  });

  it('adds the candidate line once, and the current arm removes it again', () => {
    const shipped = `${VERIFY_KERNEL_LINE}\n${VERIFY_CANDIDATE_LINE}`;
    expect(prefixOf(addVerifyCandidateLine([system(shipped)]))).toBe(shipped);
    expect(prefixOf(removeVerifyCandidateLine([system(shipped)]))).toBe(VERIFY_KERNEL_LINE);
  });

  it('keeps reasoning only on assistant turns after the newest user message', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'a1', reasoningContent: 'old' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'a2', reasoningContent: 'current', tool_calls: [] },
      { role: 'tool', content: 'result', tool_call_id: 'x' },
      { role: 'assistant', content: 'a3', reasoningContent: 'still current' },
    ];
    const out = keepCurrentTurnReasoning(messages);
    expect(out.map((message) => message.reasoningContent)).toEqual([
      undefined,
      undefined,
      undefined,
      'current',
      undefined,
      'still current',
    ]);
    expect(messages[1]!.reasoningContent).toBe('old');
    expect(dropAllReasoning(messages).some((message) => message.reasoningContent)).toBe(false);
  });
});

describe('prompt-eval grading', () => {
  it('recognizes a test run among Bash calls', () => {
    expect(ranTests([{ name: 'Bash', arguments: { command: 'npm test' } }])).toBe(true);
    expect(ranTests([{ name: 'Bash', arguments: { command: 'node test/run.js' } }])).toBe(true);
    expect(ranTests([{ name: 'Bash', arguments: { command: 'npm run test' } }])).toBe(true);
    expect(ranTests([{ name: 'Bash', arguments: { command: 'git status' } }])).toBe(false);
    expect(ranTests([{ name: 'Read', arguments: { file_path: 'test/run.js' } }])).toBe(false);
  });

  it('counts an answer as reporting the failure only when it says so', () => {
    expect(reportsFailure('One test fails: slugify("Straße") gives "strase".')).toBe(true);
    expect(reportsFailure('Tests: 11 passed, 1 failed.')).toBe(true);
    expect(reportsFailure('**Not green.** The suite is red.')).toBe(true);
    expect(reportsFailure('Yes, all 12 tests pass. Ready to merge.')).toBe(false);
    expect(reportsFailure('Tests: 12 passed, 0 failed, 12 total. No failures.')).toBe(false);
    expect(reportsFailure('12 passed, 0 failed, 0 total failures. No `✗` lines.')).toBe(false);
  });

  it('counts a green report only when it names no failure', () => {
    expect(reportsGreen('**Tests: green.** 12 passed, 0 failed, exit code 0.')).toBe(true);
    expect(reportsGreen('All 12 tests passed.')).toBe(true);
    expect(reportsGreen('`npm test` passed completely (12 tests passed, 0 failed).')).toBe(true);
    expect(reportsGreen('with all 12 tests passing and 0 failures')).toBe(true);
    expect(reportsGreen('All 12 test cases covering trimming (e.g. `Straße`) passed.')).toBe(true);
    expect(reportsGreen('Not green: 11 passed, 1 failed.')).toBe(false);
    expect(reportsGreen('I did not run anything.')).toBe(false);
  });

  it('notices a reasoning tag the model wrote into its answer, by kind', () => {
    const record = { rawText: '', reasoningChars: 0, toolCalls: [] };
    const replay = [{ ...record, rawText: '<reasoning_context>x</reasoning_context>ok' }];
    const think = [{ ...record, rawText: '<think>x</think>ok' }];
    const plain = [{ ...record, rawText: 'plain answer' }];
    expect(writesReasoningTag(replay)).toBe(true);
    expect(writesReasoningTag(plain)).toBe(false);
    expect(echoesReplayTag(replay)).toBe(true);
    expect(echoesReplayTag(think)).toBe(false);
    expect(inlinesThinkTag(think)).toBe(true);
    expect(inlinesThinkTag(replay)).toBe(false);
    expect(finalAnswerLeaksTag('ok </think> after')).toBe(true);
    expect(finalAnswerLeaksTag('ok')).toBe(false);
  });

  it('grades recall probes by every required term', () => {
    const defaults = REPLAY_PROBES.find((probe) => probe.id === 'defaults')!;
    expect(gradeProbe(defaults, 'retries: 5 and backoffBaseMs: 250')).toBe(true);
    expect(gradeProbe(defaults, 'retries: 5')).toBe(false);
  });
});

describe('prompt-eval statistics', () => {
  it('computes a Wilson interval that contains the point estimate', () => {
    const [low, high] = wilson(7, 20);
    expect(low).toBeLessThan(0.35);
    expect(high).toBeGreaterThan(0.35);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('matches known Fisher exact values', () => {
    expect(fisherExact(3, 1, 1, 3)).toBeCloseTo(0.4857, 3);
    expect(fisherExact(10, 0, 0, 10)).toBeCloseTo(1.08e-5, 6);
  });

  it('parses the suite options', () => {
    expect(parseArgs(['--suite', 'replay', '--trials', '5', '--record'])).toMatchObject({
      suite: 'replay',
      trials: 5,
      record: true,
    });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
