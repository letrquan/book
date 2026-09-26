import { EventEmitter } from 'node:events';
import { Text, useStdin } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => cleanup());

describe('Ink stdin contract', () => {
  it('passes raw input events to useStdin, which TranscriptView reads mouse reports from', () => {
    let emitter: unknown;
    function Probe() {
      emitter = (useStdin() as { internal_eventEmitter?: unknown }).internal_eventEmitter;
      return <Text>probe</Text>;
    }
    render(<Probe />);
    expect(emitter).toBeInstanceOf(EventEmitter);
  });
});
