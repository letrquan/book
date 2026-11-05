import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { AgentMessage } from './AgentMessage.js';
import { PlanApprovalDetails } from './PlanApprovalButtons.js';
import { Dialog } from './Dialog.js';
import { ReportBody } from './ReportSheet.js';
import { ToolCallBlock } from './ToolCallBlock.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { Message } from '../../types/messages.js';

/**
 * #700: the same tab-separated text lines up the same in every surface that draws Markdown. A
 * block sits on a different column in each frame, and counting the stops from its own left edge
 * put them two columns right of the terminal's own (more in a result, a thought and a sheet).
 * `a<TAB>b` (one character before the tab) puts `b` on the first absolute stop, column 8, whatever the frame.
 */

afterEach(cleanup);

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

/** The screen column of `second`, on the row that holds `first` and then `second`. */
function columnOf(output: string, first: string, second: string): number {
  const pattern = new RegExp(`${first}\\s+${second}`);
  const row = stripAnsi(output)
    .split('\n')
    .find((candidate) => pattern.test(candidate));
  expect(row, output).toBeDefined();
  return row!.indexOf(second, row!.search(pattern));
}

function assistant(content: string, reasoningContent?: string): Message {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    includeInContext: true,
    timestamp: 1,
    ...(reasoningContent ? { reasoningContent } : {}),
  };
}

describe('Markdown tab stops line up in every frame (#700)', () => {
  const STOP = 8;

  it('prose, after the item mark', () => {
    const view = render(
      withTheme(
        <AgentMessage message={assistant('P\u0009Q')} isStreaming={false} terminalWidth={80} />,
      ),
    );
    expect(columnOf(view.lastFrame() ?? '', 'P', 'Q')).toBe(STOP);
  });

  it('a thought, past its rail and indent', () => {
    const view = render(
      withTheme(
        <AgentMessage
          message={assistant('answer', 'T\u0009U')}
          isStreaming={false}
          showThinking
          transcriptMode="detailed"
          reducedMotion
          terminalWidth={80}
        />,
      ),
    );
    expect(columnOf(view.lastFrame() ?? '', 'T', 'U')).toBe(STOP);
  });

  it('a tool result, past its connector', () => {
    const view = render(
      withTheme(
        <ToolCallBlock
          name="WebFetch"
          args={{ url: 'https://example.com' }}
          result={{
            version: 2,
            toolCallId: 'call-1',
            status: 'success',
            content: 'R\u0009S',
          }}
          isExpanded
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );
    expect(columnOf(view.lastFrame() ?? '', 'R', 'S')).toBe(STOP);
  });

  it('a plan sheet', () => {
    const view = render(withTheme(<PlanApprovalDetails plan={'V\u0009W'} terminalWidth={80} />));
    expect(columnOf(view.lastFrame() ?? '', 'V', 'W')).toBe(STOP);
  });

  it('a report sheet, in the dialog that pads it', () => {
    const view = render(
      withTheme(
        <Dialog title="Report" terminalWidth={80} maxBodyRows={10} scrollable={false}>
          <ReportBody sheet={{ title: 'Report', content: 'X\u0009Y' }} terminalWidth={80} />
        </Dialog>,
      ),
    );
    expect(columnOf(view.lastFrame() ?? '', 'X', 'Y')).toBe(STOP);
  });

  it('a screen-reader sheet draws flush, with nothing to its left', () => {
    const view = render(
      withTheme(
        <ReportBody
          sheet={{ title: 'Report', content: 'X\u0009Y' }}
          terminalWidth={80}
          screenReader
        />,
      ),
    );
    expect(columnOf(view.lastFrame() ?? '', 'X', 'Y')).toBe(STOP);
  });
});
